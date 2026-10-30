import * as cheerio from "cheerio";
import { z } from "zod";
import type { RawStock } from "../types.js";
import { parseBR } from "../utils/parseBR.js";
import { retry } from "../utils/retry.js";

const FUNDAMENTUS_URL = "https://www.fundamentus.com.br/resultado.php";

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
});

// Índices verificados na página real do Fundamentus resultado.php (2026-10):
// 0:Papel 1:Cotação 2:P/L 3:P/VP 4:PSR 5:Div.Yield 6:P/Ativo 7:P/Cap.Giro
// 8:P/EBIT 9:P/Ativ Circ.Liq 10:EV/EBIT 11:EV/EBITDA 12:Mrg Bruta
// 13:Mrg Ebit 14:Mrg. Líq. 15:Liq. Corr. 16:ROIC 17:ROE
// 18:Liq.2meses 19:Patrim. Líq 20:Dív.Líq/Patrim. 21:Cresc. Rec.5a
// A tabela NÃO tem coluna de setor — classificação feita pelo ticker.
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

// Prefixos de tickers financeiros brasileiros conhecidos
const PREFIXOS_FINANCEIROS = new Set([
  "BBAS",
  "ITUB",
  "BBDC",
  "SANB",
  "BPAC",
  "BRSR",
  "BMGB",
  "PINE",
  "BGIP",
  "BPAN",
  "BAZA",
  "BRIV",
  "CRIV",
  "IDVL",
  "MODL",
  "PRBC",
  "BBSE",
  "CXSE",
  "IRBR",
  "PSSA",
  "ITSA",
  "BRGE",
]);

function setorPorTicker(ticker: string): string {
  return PREFIXOS_FINANCEIROS.has(ticker.slice(0, 4).toUpperCase()) ? "Bancos" : "Outros";
}

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

export async function fetchFundamentus(): Promise<RawStock[]> {
  const html = await retry(async () => {
    const res = await fetch(FUNDAMENTUS_URL, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`Fundamentus HTTP ${res.status}`);
    // Página em ISO-8859-1
    const buf = await res.arrayBuffer();
    return new TextDecoder("latin1").decode(buf);
  });

  return parseHtml(html);
}

export function parseHtml(html: string, minRows = 50): RawStock[] {
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
    const setor = colFixture !== null ? text(colFixture.setor) : setorPorTicker(ticker);

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
