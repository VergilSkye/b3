import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PeriodResult } from "../backtest/engine.js";
import type { BacktestMetrics } from "../backtest/metrics.js";

export interface GridEntry {
  label: string;
  color: string;
  metrics: BacktestMetrics;
  isBase?: boolean;
}

function equityCurve(periods: PeriodResult[], returnKey: "portfolioReturn"): number[] {
  let eq = 100;
  const pts: number[] = [eq];
  for (const p of periods) {
    eq *= 1 + p[returnKey];
    pts.push(Math.round(eq * 100) / 100);
  }
  return pts;
}

function benchCurve(periods: PeriodResult[]): number[] | null {
  if (periods.some((p) => p.benchmarkReturn === null)) return null;
  let eq = 100;
  const pts: number[] = [eq];
  for (const p of periods) {
    eq *= 1 + (p.benchmarkReturn as number);
    pts.push(Math.round(eq * 100) / 100);
  }
  return pts;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function metricsRow(label: string, m: BacktestMetrics, style: string): string {
  const alpha = m.benchmarkCagr !== null ? pct(m.cagr - m.benchmarkCagr) : "—";
  return `<tr${style}>
      <td>${label}</td>
      <td>${pct(m.cagr)}</td>
      <td>${m.sharpe !== null ? m.sharpe.toFixed(2) : "—"}</td>
      <td>${pct(m.maxDrawdown)}</td>
      <td>${pct(m.totalReturn)}</td>
      <td>${alpha}</td>
    </tr>`;
}

/**
 * Gera docs/backtest/index.html com curva de equity (Chart.js) e tabela de métricas.
 */
export function gravarBacktestHtml(entries: GridEntry[], outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });

  if (entries.length === 0) throw new Error("gravarBacktestHtml: sem entries");

  const base = entries.find((e) => e.isBase) ?? (entries[0] as GridEntry);
  const periods = base.metrics.periods;

  // Datas no eixo X: startDate do primeiro + todos os endDates
  const labels = [periods[0]?.startDate ?? "", ...periods.map((p) => p.endDate)];

  // Datasets Chart.js — construídos como objeto JS serializado
  type DS = {
    label: string;
    data: number[];
    borderColor: string;
    backgroundColor: string;
    borderWidth: number;
    tension: number;
    borderDash?: number[];
  };

  const datasets: DS[] = entries.map((e) => ({
    label: e.label,
    data: equityCurve(e.metrics.periods, "portfolioReturn"),
    borderColor: e.color,
    backgroundColor: "transparent",
    borderWidth: e.isBase ? 2.5 : 1.5,
    tension: 0.1,
  }));

  const bova11Data = benchCurve(periods);
  if (bova11Data) {
    datasets.push({
      label: "BOVA11",
      data: bova11Data,
      borderColor: "#111",
      backgroundColor: "transparent",
      borderWidth: 2.5,
      borderDash: [6, 3],
      tension: 0.1,
    });
  }

  // Tabela de métricas
  const tableRows = entries
    .map((e) => {
      const style = e.isBase ? ' style="font-weight:bold;background:#fffbe6"' : "";
      return metricsRow(e.label, e.metrics, style);
    })
    .join("\n");

  const bm = base.metrics;
  const bova11Row =
    bm.benchmarkCagr !== null && bm.benchmarkTotalReturn !== null
      ? `<tr style="font-style:italic;color:#555">
      <td>BOVA11 (benchmark)</td>
      <td>${pct(bm.benchmarkCagr)}</td>
      <td>—</td><td>—</td>
      <td>${pct(bm.benchmarkTotalReturn)}</td>
      <td>—</td>
    </tr>`
      : "";

  const geradoEm = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backtest quant-b3</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1050px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { border-bottom: 2px solid #333; padding-bottom: .5rem; }
    h2 { margin-top: 2rem; color: #444; }
    .chart-wrap { position: relative; height: 420px; margin: 1.5rem 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: .5rem .75rem; border: 1px solid #ddd; text-align: right; }
    th:first-child, td:first-child { text-align: left; min-width: 200px; }
    thead tr { background: #f4f4f4; }
    tbody tr:nth-child(even) { background: #fafafa; }
    a { color: #0066cc; }
    footer { margin-top: 3rem; font-size: .8rem; color: #888; }
  </style>
</head>
<body>
  <h1>Backtest quant-b3 — Grid de parâmetros</h1>
  <p>
    Estratégia quantitativa de valor, rebalanceamento semestral.<br>
    Período: <strong>${labels[0]}</strong> → <strong>${labels[labels.length - 1]}</strong>
    &nbsp;(${base.metrics.nPeriods} semestres · ${(base.metrics.nPeriods * 0.5).toFixed(1)} anos).
    &nbsp;<a href="../index.html">← Ranking atual</a>
  </p>

  <h2>Curva de equity (base 100)</h2>
  <div class="chart-wrap">
    <canvas id="equity-chart"></canvas>
  </div>

  <h2>Métricas por configuração</h2>
  <table>
    <thead><tr>
      <th>Configuração</th>
      <th>CAGR</th>
      <th>Sharpe</th>
      <th>Max DD</th>
      <th>Retorno total</th>
      <th>Alpha CAGR</th>
    </tr></thead>
    <tbody>
      ${tableRows}
      ${bova11Row}
    </tbody>
  </table>

  <footer>Gerado em ${geradoEm} · quant-b3 · Não é recomendação de investimento.</footer>

  <script>
    new Chart(document.getElementById('equity-chart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: ${JSON.stringify(datasets)},
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1),
            },
          },
        },
        scales: {
          y: { title: { display: true, text: 'Carteira (base 100)' } },
          x: { ticks: { maxRotation: 45 } },
        },
      },
    });
  </script>
</body>
</html>`;

  writeFileSync(outPath, html, "utf-8");
}
