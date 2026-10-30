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

// Mapeamento: chave interna → possíveis textos de cabeçalho do Fundamentus
const HEADER_MAP: Record<string, string[]> = {
  ticker: ["papel"],
  setor: ["segmento", "setor", "subsetor"],
  pl: ["p/l"],
  pvp: ["p/vp"],
  evEbit: ["ev/ebit"],
  pl12m: ["mrg. líq.", "mrg.líq.", "mrg liq"],
  roe: ["roe"],
  liquidezMedia: ["liq.2meses", "liq. 2meses", "liquidez 2m"],
  patLiq: ["patrim. líq", "patrim líq", "patrimônio líq"],
};

function buildColMap($: ReturnType<typeof cheerio.load>): Map<string, number> {
  const colMap = new Map<string, number>();
  $("#resultado thead th, #resultado thead td").each((i, el) => {
    const text = $(el).text().trim().toLowerCase();
    for (const [field, variants] of Object.entries(HEADER_MAP)) {
      if (variants.some((v) => text.includes(v))) {
        colMap.set(field, i);
      }
    }
  });
  return colMap;
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

  const colMap = buildColMap($);

  // Fallback para fixture de testes (sem thead), usa índices fixos baseados na fixture
  const col = (field: string, fallback: number) => colMap.get(field) ?? fallback;

  $("#resultado tbody tr").each((_i, el) => {
    const cells = $(el).find("td");
    if (cells.length < 10) return;

    const text = (i: number) => $(cells[i])?.text().trim() ?? "";

    const raw = {
      ticker: text(col("ticker", 0)),
      setor: text(col("setor", 1)),
      pl: parseBR(text(col("pl", 2))),
      pvp: parseBR(text(col("pvp", 3))),
      evEbit: parseBR(text(col("evEbit", 5))),
      pl12m: parseBR(text(col("pl12m", 8))),
      roe: parseBR(text(col("roe", 9))),
      liquidezMedia: parseBR(text(col("liquidezMedia", 10))),
      patLiq: parseBR(text(col("patLiq", 11))),
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

/** Exporta o mapa de colunas detectado (útil para debug). */
export function debugColMap(html: string): Record<string, number> {
  const $ = cheerio.load(html);
  return Object.fromEntries(buildColMap($));
}
