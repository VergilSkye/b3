import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";

const BASE_URL = "https://bvmf.bmfbovespa.com.br/InstDados/SerHist";

export interface DailyPrice {
  date: string; // YYYYMMDD
  close: number; // preço real (já dividido por 100)
}

async function downloadZip(year: number, cacheDir: string): Promise<string> {
  const zipName = `COTAHIST_A${year}.ZIP`;
  const zipPath = join(cacheDir, zipName);

  if (existsSync(zipPath)) {
    console.log(`  Cache hit: ${zipName}`);
    return zipPath;
  }

  const url = `${BASE_URL}/${zipName}`;
  console.log(`  Baixando ${url}...`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`COTAHIST HTTP ${res.status} para ${url}`);

  mkdirSync(cacheDir, { recursive: true });
  const buf = await res.arrayBuffer();
  writeFileSync(zipPath, Buffer.from(buf));
  console.log(`  Salvo ${zipPath} (${(buf.byteLength / 1_048_576).toFixed(1)} MB)`);
  return zipPath;
}

/**
 * Parseia conteúdo texto do COTAHIST (layout fixo, encoding latin1).
 * Filtra: TIPREG=01, CODBDI=02, TPMERC=010
 *
 * Layout relevante (posições base-0):
 *   [0-1]   TIPREG  tipo de registro
 *   [2-9]   DATPRE  data YYYYMMDD
 *   [10-11] CODBDI  código BDI ("02" = ação ON/PN ordinária)
 *   [12-23] CODNEG  ticker (trim)
 *   [24-26] TPMERC  tipo de mercado ("010" = à vista)
 *   [108-120] PREULT preço de fechamento × 100 (13 dígitos, inteiro)
 */
export function parseCotahist(content: string): Map<string, DailyPrice[]> {
  const result = new Map<string, DailyPrice[]>();

  for (const line of content.split("\n")) {
    if (line.length < 121) continue;
    if (line.slice(0, 2) !== "01") continue;
    if (line.slice(10, 12) !== "02") continue;
    if (line.slice(24, 27) !== "010") continue;

    const date = line.slice(2, 10);
    const ticker = line.slice(12, 24).trim();
    const preult = Number.parseInt(line.slice(108, 121), 10);

    if (!ticker || Number.isNaN(preult) || preult <= 0) continue;

    const close = preult / 100;

    let prices = result.get(ticker);
    if (prices === undefined) {
      prices = [];
      result.set(ticker, prices);
    }
    prices.push({ date, close });
  }

  // Garantir ordem cronológica
  for (const prices of result.values()) {
    prices.sort((a, b) => a.date.localeCompare(b.date));
  }

  return result;
}

/**
 * Baixa (com cache) e parseia COTAHIST para os anos solicitados.
 * Retorna Map<ticker, DailyPrice[]> ordenado por data.
 */
export async function loadCotahist(
  years: number[],
  cacheDir: string,
): Promise<Map<string, DailyPrice[]>> {
  const combined = new Map<string, DailyPrice[]>();

  for (const year of years) {
    const zipPath = await downloadZip(year, cacheDir);

    console.log(`  Extraindo ${zipPath}...`);
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const entry = entries[0];
    if (!entry) throw new Error(`ZIP vazio: ${zipPath}`);

    const content = entry.getData().toString("latin1");
    const priceMap = parseCotahist(content);
    console.log(`  ${priceMap.size} tickers no COTAHIST ${year}`);

    for (const [ticker, prices] of priceMap) {
      const existing = combined.get(ticker);
      if (existing === undefined) {
        combined.set(ticker, prices);
      } else {
        existing.push(...prices);
      }
    }
  }

  // Reordenar após merge
  for (const prices of combined.values()) {
    prices.sort((a, b) => a.date.localeCompare(b.date));
  }

  return combined;
}
