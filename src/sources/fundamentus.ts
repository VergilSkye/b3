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

  // A tabela de resultados tem id="resultado"
  $("#resultado tbody tr").each((_i, el) => {
    const cells = $(el).find("td");
    if (cells.length < 13) return;

    const text = (i: number) => $(cells[i]).text().trim();

    const raw = {
      ticker: text(0),
      setor: text(1),
      liquidezMedia: parseBR(text(10)), // Liq.2meses
      pl: parseBR(text(2)), // P/L
      pvp: parseBR(text(3)), // P/VP
      evEbit: parseBR(text(5)), // EV/EBIT
      pl12m: parseBR(text(8)), // Lucro Liq. (para filtro)
      patLiq: parseBR(text(11)), // Patrim. Líq
      roe: parseBR(text(9)), // ROE
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
