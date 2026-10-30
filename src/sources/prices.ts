import { sampleStandardDeviation } from "simple-statistics";
import { loadCotahist } from "./cotahist.js";

const TRADING_DAYS_12M = 252;
const MIN_PRICES = 21; // mínimo para considerar volatilidade válida (~1 mês)

/**
 * Calcula volatilidade anualizada a partir de uma série de fechamentos.
 * vol = desvio-padrão(log-retornos) × √252
 * Retorna null se dados insuficientes.
 */
export function calcVolatilidade(closes: number[]): number | null {
  if (closes.length < MIN_PRICES + 1) return null;

  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    if (prev <= 0 || curr <= 0) continue;
    logReturns.push(Math.log(curr / prev));
  }

  if (logReturns.length < MIN_PRICES) return null;

  const stddev = sampleStandardDeviation(logReturns);
  return stddev * Math.sqrt(TRADING_DAYS_12M);
}

/**
 * Constrói mapa ticker → volatilidade para a lista de tickers fornecida.
 * Baixa (com cache) COTAHIST do ano atual e anterior para cobrir 12 meses.
 */
export async function buildVolMap(
  tickers: string[],
  cacheDir: string,
): Promise<Map<string, number | null>> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = [currentYear - 1, currentYear];

  console.log(`Carregando COTAHIST anos ${years.join(", ")}...`);
  const priceMap = await loadCotahist(years, cacheDir);

  const volMap = new Map<string, number | null>();
  let comVol = 0;
  let semDados = 0;

  for (const ticker of tickers) {
    const prices = priceMap.get(ticker);
    if (!prices || prices.length === 0) {
      volMap.set(ticker, null);
      semDados++;
      continue;
    }

    // Últimos 252 pregões
    const closes = prices.slice(-TRADING_DAYS_12M).map((p) => p.close);
    const vol = calcVolatilidade(closes);
    volMap.set(ticker, vol);
    if (vol !== null) comVol++;
    else semDados++;
  }

  const total = tickers.length;
  const cobertura = total > 0 ? ((comVol / total) * 100).toFixed(1) : "0";
  console.log(`  Cobertura de volatilidade: ${comVol}/${total} tickers (${cobertura}%)`);

  return volMap;
}
