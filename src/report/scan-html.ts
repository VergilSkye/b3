import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ScanEntry {
  rank: number;
  ticker: string;
  setor: string;
  evEbit: number;
  pl: number;
  pvp: number | null;
  quedaRelativa: number; // retorno stock − retorno BOVA11
  retornoStock: number;
  retornoBova: number;
  score: number;
}

export interface ScanResult {
  dateToday: string;
  date30d: string;
  date60d: string;
  date90d: string;
  top30d: ScanEntry[];
  top60d: ScanEntry[];
  top90d: ScanEntry[];
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function tableHtml(entries: ScanEntry[], window: string, refDate: string): string {
  if (entries.length === 0) return `<p>Sem candidatos para janela ${window}.</p>`;

  const rows = entries
    .map(
      (e) => `<tr>
      <td>${e.rank}</td>
      <td><strong>${e.ticker}</strong></td>
      <td>${e.setor}</td>
      <td>${e.evEbit.toFixed(2)}</td>
      <td>${e.pl.toFixed(2)}</td>
      <td>${e.pvp !== null ? e.pvp.toFixed(2) : "—"}</td>
      <td style="color:${e.retornoStock < 0 ? "#c00" : "#080"}">${pct(e.retornoStock)}</td>
      <td style="color:${e.retornoBova < 0 ? "#c00" : "#080"}">${pct(e.retornoBova)}</td>
      <td style="color:#c00;font-weight:bold">${pct(e.quedaRelativa)}</td>
      <td>${e.score}</td>
    </tr>`,
    )
    .join("\n");

  return `
  <h2>Janela ${window} (desde ${refDate})</h2>
  <table>
    <thead><tr>
      <th>#</th><th>Ticker</th><th>Setor</th>
      <th>EV/EBIT</th><th>P/L</th><th>P/VP</th>
      <th>Retorno ação</th><th>Retorno BOVA11</th>
      <th>Queda relativa</th><th>Score</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Gera docs/scan/index.html com os candidatos à recuperação pós circuit-breaker.
 */
export function gravarScanHtml(result: ScanResult, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });

  const geradoEm = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scan pós circuit-breaker — quant-b3</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { border-bottom: 2px solid #333; padding-bottom: .5rem; }
    h2 { margin-top: 2.5rem; color: #444; }
    table { width: 100%; border-collapse: collapse; margin-top: .75rem; font-size: .9rem; }
    th, td { padding: .4rem .6rem; border: 1px solid #ddd; text-align: right; }
    th:nth-child(-n+3), td:nth-child(-n+3) { text-align: left; }
    thead tr { background: #f4f4f4; }
    tbody tr:nth-child(even) { background: #fafafa; }
    tbody tr:hover { background: #f0f4ff; }
    a { color: #0066cc; }
    footer { margin-top: 3rem; font-size: .8rem; color: #888; }
    .note { background: #fff8e1; border-left: 4px solid #fbc02d; padding: .75rem 1rem; margin: 1rem 0; font-size: .9rem; }
  </style>
</head>
<body>
  <h1>Scan pós circuit-breaker — candidatos à recuperação</h1>
  <p>
    Data de referência: <strong>${result.dateToday}</strong> &nbsp;·&nbsp;
    Janelas: 30 d (${result.date30d}), 60 d (${result.date60d}), 90 d (${result.date90d})
    &nbsp;<a href="../index.html">← Ranking atual</a>
  </p>
  <div class="note">
    <strong>Metodologia:</strong> score = rank(queda relativa ↑) + rank(EV/EBIT ↑).
    Filtragem: liquidez ≥ R$1M · EV/EBIT > 0 · P/L > 0.
    Queda relativa = retorno da ação − retorno do BOVA11 no período.
    Quanto mais negativa a queda relativa e menor o EV/EBIT, melhor o score.
  </div>

  ${tableHtml(result.top30d, "30 dias", result.date30d)}
  ${tableHtml(result.top60d, "60 dias", result.date60d)}
  ${tableHtml(result.top90d, "90 dias", result.date90d)}

  <footer>Gerado em ${geradoEm} · quant-b3 · Não é recomendação de investimento.</footer>
</body>
</html>`;

  writeFileSync(outPath, html, "utf-8");
}
