import type { BacktestResult, PeriodResult } from "./engine.js";

export interface BacktestMetrics {
  cagr: number; // retorno anualizado composto
  totalReturn: number; // retorno total acumulado
  sharpe: number | null; // Sharpe anualizado (rf=0)
  maxDrawdown: number; // drawdown máximo (negativo ou zero)
  benchmarkCagr: number | null; // CAGR do benchmark
  benchmarkTotalReturn: number | null;
  nPeriods: number;
  periods: PeriodResult[];
}

/**
 * Calcula CAGR, Sharpe anualizado e drawdown máximo.
 * Suporta qualquer periodicidade via result.periodYears (ex: 0.5 = semestral).
 */
export function calcMetrics(result: BacktestResult): BacktestMetrics {
  const { periods, periodYears } = result;
  if (periods.length === 0) throw new Error("Sem períodos para calcular métricas");

  const returns = periods.map((p) => p.portfolioReturn);
  const periodsPerYear = 1 / periodYears; // 2 para semestral, 1 para anual

  // Total return e CAGR
  const totalReturn = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const totalYears = periods.length * periodYears;
  const cagr = (1 + totalReturn) ** (1 / totalYears) - 1;

  // Sharpe anualizado (rf=0): mean/std × √periodsPerYear
  let sharpe: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : null;
  }

  // Max drawdown
  let peak = 1;
  let equity = 1;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = equity / peak - 1;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Benchmark
  const benchReturns = periods.map((p) => p.benchmarkReturn).filter((r): r is number => r !== null);
  let benchmarkCagr: number | null = null;
  let benchmarkTotalReturn: number | null = null;
  if (benchReturns.length === periods.length) {
    benchmarkTotalReturn = benchReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
    benchmarkCagr = (1 + benchmarkTotalReturn) ** (1 / totalYears) - 1;
  }

  return {
    cagr,
    totalReturn,
    sharpe,
    maxDrawdown,
    benchmarkCagr,
    benchmarkTotalReturn,
    nPeriods: periods.length,
    periods,
  };
}

export function formatMetrics(m: BacktestMetrics): string {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const lines: string[] = [
    "=== Backtest Metrics ===",
    `Períodos: ${m.nPeriods}`,
    `Retorno total:  ${pct(m.totalReturn)}`,
    `CAGR:           ${pct(m.cagr)}`,
    `Sharpe:         ${m.sharpe !== null ? m.sharpe.toFixed(2) : "n/a"}`,
    `Max Drawdown:   ${pct(m.maxDrawdown)}`,
  ];

  if (m.benchmarkCagr !== null && m.benchmarkTotalReturn !== null) {
    lines.push(
      "",
      "--- Benchmark (BOVA11) ---",
      `Retorno total:  ${pct(m.benchmarkTotalReturn)}`,
      `CAGR:           ${pct(m.benchmarkCagr)}`,
      `Alpha (CAGR):   ${pct(m.cagr - m.benchmarkCagr)}`,
    );
  }

  lines.push("", "--- Períodos ---");
  for (const p of m.periods) {
    const bench = p.benchmarkReturn !== null ? `  BOVA11: ${pct(p.benchmarkReturn)}` : "";
    lines.push(`  ${p.startDate} → ${p.endDate}: ${pct(p.portfolioReturn)}${bench}`);
  }

  return lines.join("\n");
}
