import { sampleStandardDeviation } from "simple-statistics";
import { loadCotahist } from "./cotahist.js";

const TRADING_DAYS_12M = 252;
const MIN_PRICES = 21; // mínimo para considerar volatilidade válida (~1 mês)

// Momentum 12-1: retorno de 13 meses atrás até 1 mês atrás (exclui último mês)
const MOM_DAYS_1M = 21; // ~1 mês de pregões
const MOM_DAYS_13M = 273; // ~13 meses de pregões

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
 * Constrói mapas de volatilidade e momentum (12-1m) num único pass do COTAHIST.
 * Baixa (com cache) COTAHIST do ano atual e anterior para cobrir ~14 meses.
 */
export async function buildVolAndMomMaps(
  tickers: string[],
  cacheDir: string,
): Promise<{ volMap: Map<string, number | null>; momMap: Map<string, number | null> }> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = [currentYear - 1, currentYear];

  console.log(`Carregando COTAHIST anos ${years.join(", ")}...`);
  const priceMap = await loadCotahist(years, cacheDir);

  const volMap = new Map<string, number | null>();
  const momMap = new Map<string, number | null>();
  let comVol = 0;
  let comMom = 0;

  for (const ticker of tickers) {
    const prices = priceMap.get(ticker);
    if (!prices || prices.length === 0) {
      volMap.set(ticker, null);
      momMap.set(ticker, null);
      continue;
    }

    // Volatilidade: últimos 252 pregões
    const closes = prices.slice(-TRADING_DAYS_12M).map((p) => p.close);
    const vol = calcVolatilidade(closes);
    volMap.set(ticker, vol);
    if (vol !== null) comVol++;

    // Momentum 12-1: preço a 13m atrás → preço a 1m atrás (exclui último mês)
    const N = prices.length;
    if (N > MOM_DAYS_13M) {
      const p1m = prices[N - 1 - MOM_DAYS_1M];
      const p13m = prices[N - 1 - MOM_DAYS_13M];
      const mom12m = p1m && p13m && p13m.close > 0 ? p1m.close / p13m.close - 1 : null;
      momMap.set(ticker, mom12m);
      if (mom12m !== null) comMom++;
    } else {
      momMap.set(ticker, null);
    }
  }

  const total = tickers.length;
  const cobVol = total > 0 ? ((comVol / total) * 100).toFixed(1) : "0";
  const cobMom = total > 0 ? ((comMom / total) * 100).toFixed(1) : "0";
  console.log(`  Vol: ${comVol}/${total} (${cobVol}%)  Mom: ${comMom}/${total} (${cobMom}%)`);

  return { volMap, momMap };
}

/**
 * Constrói mapa ticker → volatilidade. Wrapper de buildVolAndMomMaps para compatibilidade.
 */
export async function buildVolMap(
  tickers: string[],
  cacheDir: string,
): Promise<Map<string, number | null>> {
  const { volMap } = await buildVolAndMomMaps(tickers, cacheDir);
  return volMap;
}
