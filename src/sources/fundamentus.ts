import * as cheerio from "cheerio";
import { z } from "zod";
import type { RawStock } from "../types.js";
import { parseBR } from "../utils/parseBR.js";
import { retry } from "../utils/retry.js";

const BASE_URL = "https://www.fundamentus.com.br";
const RESULTADO_URL = `${BASE_URL}/resultado.php`;
const BUSCA_URL = `${BASE_URL}/buscaavancada.php`;

// Setores financeiros que precisam de classificação precisa para o ranking separado.
// IDs extraídos de buscaavancada.php <select name="setor">.
const FINANCIAL_SECTORS = [
  { id: 20, nome: "Intermediários Financeiros" },
  { id: 31, nome: "Previdência e Seguros" },
  { id: 37, nome: "Serviços Financeiros Diversos" },
] as const;

const DELAY_BETWEEN_REQUESTS_MS = 3000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Schema zod para validar cada linha da tabela
const RawRowSchema = z.object({
  ticker: z.string().min(4),
  setor: z.string(),
  liquidezMedia: z.number().nullable(),
  pl: z.number().nullable(),
  pvp: z.number().nullable(),
  evEbit: z.number().nullable(),
  pl12m: z.number().nullable(),
  patLiq: z.number().nullable(),
  roe: z.number().nullable(),
  mom12m: z.number().nullable().default(null), // preenchido depois via COTAHIST
});

// Índices verificados na página real do Fundamentus resultado.php (2026-10):
// 0:Papel 1:Cotação 2:P/L 3:P/VP 4:PSR 5:Div.Yield 6:P/Ativo 7:P/Cap.Giro
// 8:P/EBIT 9:P/Ativ Circ.Liq 10:EV/EBIT 11:EV/EBITDA 12:Mrg Bruta
// 13:Mrg Ebit 14:Mrg. Líq. 15:Liq. Corr. 16:ROIC 17:ROE
// 18:Liq.2meses 19:Patrim. Líq 20:Dív.Líq/Patrim. 21:Cresc. Rec.5a
// A tabela NÃO tem coluna de setor — classificação feita pelo setor do POST.
const COL_REAL = {
  ticker: 0,
  pl: 2,
  pvp: 3,
  evEbit: 10,
  pl12m: 14,
  roe: 17,
  liquidezMedia: 18,
  patLiq: 19,
};

// Para a fixture de testes (que tem coluna Segmento), mapear por cabeçalho
function buildColFixture(headers: string[]): typeof COL_REAL & { setor: number } {
  const idx = (terms: string[]) => headers.findIndex((h) => terms.some((t) => h.includes(t)));
  return {
    ticker: idx(["papel"]),
    setor: idx(["segmento", "setor"]),
    pl: idx(["p/l"]),
    pvp: idx(["p/vp"]),
    evEbit: idx(["ev/ebit"]),
    pl12m: idx(["mrg. líq", "mrg liq"]),
    roe: idx(["roe"]),
    liquidezMedia: idx(["liq.2meses"]),
    patLiq: idx(["patrim"]),
  };
}

/**
 * Coleta dados do Fundamentus em dois passos para evitar rate limiting:
 * 1. Um POST sem filtro de setor → todos os ~400 tickers com dados financeiros.
 * 2. Um POST por setor financeiro (3 setores) para classificação precisa.
 *
 * O site bloqueia após ~5 POSTs rápidos consecutivos; 3 s entre requisições é suficiente.
 */
export async function fetchFundamentus(): Promise<RawStock[]> {
  // 1. Todos os tickers em um único POST
  const bulkHtml = await retry(async () => {
    const res = await fetch(RESULTADO_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: BUSCA_URL,
      },
      body: "negociada=ON&ordem=1&x=28&y=16",
    });
    if (!res.ok) throw new Error(`Fundamentus bulk HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder("latin1").decode(buf);
  });

  const allStocks = parseHtml(bulkHtml, 50, "Outros");
  console.log(`  ${allStocks.length} tickers coletados (bulk)`);

  // 2. Classificar setores financeiros com POSTs separados
  const tickerSetor = new Map<string, string>();

  for (const { id, nome } of FINANCIAL_SECTORS) {
    await new Promise<void>((resolve) => setTimeout(resolve, DELAY_BETWEEN_REQUESTS_MS));

    const html = await retry(async () => {
      const res = await fetch(RESULTADO_URL, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: BUSCA_URL,
        },
        body: `setor=${id}&negociada=ON&ordem=1&x=28&y=16`,
      });
      if (!res.ok) throw new Error(`Fundamentus setor ${id} HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return new TextDecoder("latin1").decode(buf);
    });

    const rows = parseHtml(html, 0, nome);
    for (const row of rows) tickerSetor.set(row.ticker, nome);
    console.log(`  Setor ${nome}: ${rows.length} tickers`);
  }

  // 3. Sobrescrever setor nos tickers financeiros
  return allStocks.map((s) => {
    const setor = tickerSetor.get(s.ticker);
    return setor ? { ...s, setor } : s;
  });
}

/**
 * Parseia o HTML da tabela #resultado.
 * setorOverride: nome do setor para ações quando a tabela não tem coluna de setor.
 * minRows = 0 para requisições por setor (sem mínimo por página).
 */
export function parseHtml(html: string, minRows = 50, setorOverride?: string): RawStock[] {
  const $ = cheerio.load(html);
  const rows: RawStock[] = [];

  const headers = $("#resultado thead th")
    .map((_i, el) => $(el).text().trim().toLowerCase())
    .get();

  const hasSetor = headers.some((h) => h.includes("segmento") || h.includes("setor"));
  const colFixture = hasSetor ? buildColFixture(headers) : null;

  $("#resultado tbody tr").each((_i, el) => {
    const cells = $(el).find("td");
    if (cells.length < 10) return;

    const text = (i: number) => $(cells[i])?.text().trim() ?? "";

    // Ticker: na página real está dentro de um <a>
    const tickerIdx = colFixture?.ticker ?? COL_REAL.ticker;
    const tickerCell = $(cells[tickerIdx]);
    const ticker = (tickerCell.find("a").text().trim() || tickerCell.text().trim()).toUpperCase();

    const c = colFixture ?? COL_REAL;
    const setor = colFixture !== null ? text(colFixture.setor) : (setorOverride ?? "Outros");

    const raw = {
      ticker,
      setor,
      pl: parseBR(text(c.pl)),
      pvp: parseBR(text(c.pvp)),
      evEbit: parseBR(text(c.evEbit)),
      pl12m: parseBR(text(c.pl12m)),
      roe: parseBR(text(c.roe)),
      liquidezMedia: parseBR(text(c.liquidezMedia)),
      patLiq: parseBR(text(c.patLiq)),
    };

    const parsed = RawRowSchema.safeParse(raw);
    if (parsed.success) {
      rows.push(parsed.data);
    }
  });

  if (rows.length < minRows) {
    throw new Error(`Fundamentus: parseou apenas ${rows.length} linhas — layout pode ter mudado`);
  }

  return rows;
}
