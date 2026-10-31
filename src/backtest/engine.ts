import { DEFAULT_CONFIG } from "../config.js";
import { enriquecerComVol } from "../strategy.js";
import { selectPortfolio } from "../strategy.js";
import type { Config } from "../types.js";
import { buildLastPriceMap, buildSnapshot } from "./snapshot.js";

export interface PeriodResult {
  startDate: string; // "AAAA-MM-DD"
  endDate: string; // "AAAA-MM-DD"
  portfolio: string[]; // tickers selecionados (geral + financeiros)
  portfolioReturn: number; // retorno igual-ponderado no período
  benchmarkReturn: number | null; // BOVA11 no período (null se indisponível)
  nGeral: number;
  nFin: number;
}

export interface BacktestResult {
  periods: PeriodResult[];
  config: Config;
  periodYears: number; // duração de cada período em anos (ex: 0.5 para semestral)
}

/**
 * Roda o backtest para as datas de rebalanceamento fornecidas.
 *
 * Para cada par consecutivo de datas (T0, T1):
 *   1. Snapshot em T0 → selectPortfolio → lista de tickers
 *   2. Preços em T0 e T1 → retorno igual-ponderado
 *   3. BOVA11 em T0 e T1 → retorno benchmark
 *
 * @param dates       Datas de rebalanceamento "AAAA-MM-DD" em ordem crescente.
 *                    A última data é só para calcular retorno do período anterior.
 * @param cotahistDir Diretório com TXTs do COTAHIST extraídos
 * @param cacheDir    Cache DFP + B3
 * @param config      Configuração da estratégia (default: DEFAULT_CONFIG)
 */
export async function runBacktest(
  dates: string[],
  cotahistDir: string,
  cacheDir: string,
  config: Config = DEFAULT_CONFIG,
  periodYears = 1,
): Promise<BacktestResult> {
  if (dates.length < 2) throw new Error("Precisa de pelo menos 2 datas");

  const periods: PeriodResult[] = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const startDate = dates[i] as string;
    const endDate = dates[i + 1] as string;

    console.log(`\n[engine] Período ${startDate} → ${endDate}`);

    // 1. Snapshot em T0 (inclui volMap calculada do COTAHIST)
    const { rawAcoes, volMap } = await buildSnapshot(startDate, cotahistDir, cacheDir);
    const acoes = enriquecerComVol(rawAcoes, volMap);
    const resultado = selectPortfolio(acoes, config);

    const selecionados = [
      ...resultado.geral.map((a) => a.ticker),
      ...resultado.financeiros.map((a) => a.ticker),
    ];

    console.log(
      `  Selecionados: ${resultado.geral.length} geral + ${resultado.financeiros.length} fin = ${selecionados.length} tickers`,
    );

    if (selecionados.length === 0) {
      console.warn("  Nenhum ticker selecionado — período pulado");
      continue;
    }

    // 3. Preços em T0 e T1
    const [pricesT0, pricesT1] = await Promise.all([
      buildLastPriceMap(startDate, cotahistDir),
      buildLastPriceMap(endDate, cotahistDir),
    ]);

    // 4. Retorno igual-ponderado do portfólio
    const retornos: number[] = [];
    for (const ticker of selecionados) {
      const p0 = pricesT0.get(ticker);
      const p1 = pricesT1.get(ticker);
      if (p0 && p0 > 0 && p1 && p1 > 0) {
        retornos.push(p1 / p0 - 1);
      }
    }

    const portfolioReturn =
      retornos.length > 0 ? retornos.reduce((s, r) => s + r, 0) / retornos.length : 0;

    console.log(`  Cobertura preços: ${retornos.length}/${selecionados.length} tickers`);
    console.log(`  Retorno portfólio: ${(portfolioReturn * 100).toFixed(2)}%`);

    // 5. Benchmark: BOVA11
    const b0 = pricesT0.get("BOVA11");
    const b1 = pricesT1.get("BOVA11");
    const benchmarkReturn = b0 && b0 > 0 && b1 && b1 > 0 ? b1 / b0 - 1 : null;
    if (benchmarkReturn !== null) {
      console.log(`  BOVA11: ${(benchmarkReturn * 100).toFixed(2)}%`);
    }

    periods.push({
      startDate,
      endDate,
      portfolio: selecionados,
      portfolioReturn,
      benchmarkReturn,
      nGeral: resultado.geral.length,
      nFin: resultado.financeiros.length,
    });
  }

  return { periods, config, periodYears };
}
