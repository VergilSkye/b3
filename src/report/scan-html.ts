import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NAV_CSS, htmlMtime, navHtml } from "./nav.js";

export interface ScanEntry {
  rank: number;
  ticker: string;
  setor: string;
  evEbit: number;
  pl: number;
  pvp: number | null;
  quedaRelativa: number;
  retornoStock: number;
  retornoBova: number;
  score: number;
  pctAboveMin52w: number | null; // % acima da mínima de 52 semanas (0 = na mínima)
  janelas: number; // em quantas janelas (30/60/90d) o ticker aparece: 1, 2 ou 3
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

function pct(v: number, digits = 2): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function near52wBadge(e: ScanEntry): string {
  if (e.pctAboveMin52w === null) return "";
  if (e.pctAboveMin52w <= 0.05) return ' <span class="badge badge-red">Mín52s</span>';
  if (e.pctAboveMin52w <= 0.15) return ' <span class="badge badge-orange">~Mín52s</span>';
  return "";
}

function janelasBadge(n: number): string {
  if (n === 3) return '<span class="badge badge-red">3/3</span>';
  if (n === 2) return '<span class="badge badge-orange">2/3</span>';
  return '<span class="badge badge-gray">1/3</span>';
}

function tableHtml(entries: ScanEntry[], window: string, refDate: string): string {
  if (entries.length === 0) return `<p>Sem candidatos para janela ${window}.</p>`;

  const rows = entries
    .map(
      (e) => `<tr>
      <td>${e.rank}</td>
      <td><strong>${e.ticker}</strong>${near52wBadge(e)}</td>
      <td>${e.setor}</td>
      <td>${e.evEbit.toFixed(2)}</td>
      <td>${e.pl.toFixed(2)}</td>
      <td>${e.pvp !== null ? e.pvp.toFixed(2) : "—"}</td>
      <td style="color:${e.retornoStock < 0 ? "#c00" : "#080"}">${pct(e.retornoStock)}</td>
      <td style="color:${e.retornoBova < 0 ? "#c00" : "#080"}">${pct(e.retornoBova)}</td>
      <td style="color:#c00;font-weight:bold">${pct(e.quedaRelativa)}</td>
      <td>${e.pctAboveMin52w !== null ? `+${pct(e.pctAboveMin52w, 1)}` : "—"}</td>
      <td>${janelasBadge(e.janelas)}</td>
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
      <th>Queda relativa</th><th>↑ Mín52s</th><th>Janelas</th><th>Score</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function consensoHtml(result: ScanResult): string {
  // Tickers que aparecem em 2+ janelas, ordenados por janelas desc e score médio asc
  const all = [...result.top30d, ...result.top60d, ...result.top90d];
  const byTicker = new Map<string, ScanEntry[]>();
  for (const e of all) {
    const arr = byTicker.get(e.ticker) ?? [];
    arr.push(e);
    byTicker.set(e.ticker, arr);
  }

  const consenso: Array<{ ticker: string; janelas: number; scoreMin: number; entry: ScanEntry }> =
    [];
  for (const [ticker, entries] of byTicker) {
    if (entries.length < 2) continue;
    const scoreMin = Math.min(...entries.map((e) => e.score));
    consenso.push({ ticker, janelas: entries.length, scoreMin, entry: entries[0] as ScanEntry });
  }
  consenso.sort((a, b) => b.janelas - a.janelas || a.scoreMin - b.scoreMin);

  if (consenso.length === 0) return "";

  const rows = consenso
    .map(
      (c) => `<tr>
      <td><strong>${c.ticker}</strong>${near52wBadge(c.entry)}</td>
      <td>${c.entry.setor}</td>
      <td>${c.entry.evEbit.toFixed(2)}</td>
      <td>${c.entry.pl.toFixed(2)}</td>
      <td>${janelasBadge(c.janelas)}</td>
      <td>${c.entry.pctAboveMin52w !== null ? `+${pct(c.entry.pctAboveMin52w, 1)}` : "—"}</td>
    </tr>`,
    )
    .join("\n");

  return `
  <h2>Consenso (2+ janelas)</h2>
  <p>Ações que aparecem em 2 ou 3 das 3 janelas — sinal mais robusto de underperformance relativa persistente.</p>
  <table>
    <thead><tr>
      <th>Ticker</th><th>Setor</th><th>EV/EBIT</th><th>P/L</th><th>Janelas</th><th>↑ Mín52s</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Gera docs/scan/index.html com os candidatos à recuperação pós circuit-breaker.
 */
export function gravarScanHtml(result: ScanResult, outPath: string): void {
  const docsDir = dirname(dirname(outPath)); // docs/scan/.. = docs/
  mkdirSync(dirname(outPath), { recursive: true });

  const geradoEm = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const dates: Partial<Record<"ranking" | "backtest", string>> = {};
  const rkDate = htmlMtime(join(docsDir, "index.html"));
  const btDate = htmlMtime(join(docsDir, "backtest", "index.html"));
  if (rkDate) dates.ranking = rkDate;
  if (btDate) dates.backtest = btDate;
  const nav = navHtml("scan", dates);

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scan pós circuit-breaker — quant-b3</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1250px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { padding-bottom: .5rem; margin-bottom: 0; }
    h2 { margin-top: 2.5rem; color: #444; }
    ${NAV_CSS}
    table { width: 100%; border-collapse: collapse; margin-top: .75rem; font-size: .875rem; }
    th, td { padding: .4rem .6rem; border: 1px solid #ddd; text-align: right; white-space: nowrap; }
    th:nth-child(-n+3), td:nth-child(-n+3) { text-align: left; }
    thead tr { background: #f4f4f4; }
    tbody tr:nth-child(even) { background: #fafafa; }
    tbody tr:hover { background: #f0f4ff; }
    a { color: #0066cc; }
    footer { margin-top: 3rem; font-size: .8rem; color: #888; }
    .note { background: #fff8e1; border-left: 4px solid #fbc02d; padding: .75rem 1rem; margin: 1rem 0; font-size: .875rem; }
    .badge { display: inline-block; font-size: .7rem; font-weight: bold; padding: .1rem .35rem; border-radius: 3px; margin-left: .3rem; vertical-align: middle; }
    .badge-red    { background: #fde8e8; color: #c00; border: 1px solid #f5c6c6; }
    .badge-orange { background: #fff3e0; color: #e65100; border: 1px solid #ffcc80; }
    .badge-gray   { background: #f5f5f5; color: #666; border: 1px solid #ddd; }
  </style>
</head>
<body>
  ${nav}
  <h1>Scan pós circuit-breaker — candidatos à recuperação</h1>
  <p>
    Data de referência: <strong>${result.dateToday}</strong> &nbsp;·&nbsp;
    Janelas: 30 d (${result.date30d}), 60 d (${result.date60d}), 90 d (${result.date90d})
    &nbsp;<a href="../index.html">← Ranking atual</a>
  </p>
  <div class="note">
    <strong>Metodologia:</strong> score = rank(queda relativa ↑) + rank(EV/EBIT ↑).
    Filtragem: liquidez ≥ R$1M · EV/EBIT > 0 · P/L > 0 · financeiras excluídas (usar ranking separado).
    Queda relativa = retorno da ação − retorno do BOVA11 no período.
    <strong>↑ Mín52s</strong>: percentual acima da mínima de 52 semanas (<span class="badge badge-red">Mín52s</span> ≤ 5%, <span class="badge badge-orange">~Mín52s</span> ≤ 15%).
    <strong>Janelas</strong>: em quantas das 3 janelas o ticker aparece (<span class="badge badge-red">3/3</span> = sinal mais persistente).
  </div>

  ${consensoHtml(result)}
  ${tableHtml(result.top30d, "30 dias", result.date30d)}
  ${tableHtml(result.top60d, "60 dias", result.date60d)}
  ${tableHtml(result.top90d, "90 dias", result.date90d)}

  <footer>Gerado em ${geradoEm} · quant-b3 · Não é recomendação de investimento.</footer>
</body>
</html>`;

  writeFileSync(outPath, html, "utf-8");
}
