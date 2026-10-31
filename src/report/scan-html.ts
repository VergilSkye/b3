import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NAV_CSS, htmlMtime, navHtml } from "./nav.js";

export interface ScanEntry {
  rank: number;
  ticker: string;
  setor: string;
  fator: string; // grupo setorial para limite de concentração
  evEbit: number;
  pl: number;
  pvp: number | null;
  retornoStock: number;
  retornoBova: number;
  quedaRelativa: number;
  pctAboveMin52w: number | null;
  low52wDate: string | null; // "DD/MM/YYYY"
  low52wPrice: number | null; // R$
  conversao: number | null; // P/EBIT / P/L (eficiência operacional → lucro)
  jurosAlerta: boolean; // conversao < 0,40 AND dívida líquida > 0
  knifScore: number; // 0–5 pontos de risco
  score: number;
  janelas: number;
}

export interface ScanResult {
  dateToday: string;
  date30d: string;
  date60d: string;
  date90d: string;
  top30d: ScanEntry[];
  top60d: ScanEntry[];
  top90d: ScanEntry[];
  corporateEvents: Array<{ ticker: string; setor: string; pctAboveMin52w: number }>;
}

function pct(v: number, digits = 2): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtBRL(v: number): string {
  return `R$\u00a0${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function knifScoreBadge(score: number): string {
  if (score >= 4) return `<span class="badge badge-red">&#128308; ${score}</span>`;
  if (score >= 2) return `<span class="badge badge-orange">&#128993; ${score}</span>`;
  return `<span class="badge badge-green">&#128994; ${score}</span>`;
}

function jurosBadge(e: ScanEntry): string {
  if (!e.jurosAlerta) return "";
  const conv = e.conversao !== null ? ` (conv=${e.conversao.toFixed(2)})` : "";
  return ` <span class="badge badge-orange" title="P/EBIT\u00f7P/L${conv} &lt; 0,40 e d\u00edvida l\u00edquida &gt; 0">juros&#8593;</span>`;
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
      <td>${e.pl.toFixed(2)}${jurosBadge(e)}</td>
      <td>${e.pvp !== null ? e.pvp.toFixed(2) : "—"}</td>
      <td style="color:${e.retornoStock < 0 ? "#c00" : "#080"}">${pct(e.retornoStock)}</td>
      <td style="color:${e.retornoBova < 0 ? "#c00" : "#080"}">${pct(e.retornoBova)}</td>
      <td style="color:#c00;font-weight:bold">${pct(e.quedaRelativa)}</td>
      <td>${e.pctAboveMin52w !== null ? `+${pct(e.pctAboveMin52w, 1)}` : "—"}<br><small style="color:#999">${e.low52wDate ?? ""} ${e.low52wPrice !== null ? fmtBRL(e.low52wPrice) : ""}</small></td>
      <td>${janelasBadge(e.janelas)}</td>
      <td>${knifScoreBadge(e.knifScore)}</td>
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
      <th>Queda relativa</th><th>↑ Mín52s</th><th>Janelas</th><th>Risco</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function sectorSummaryHtml(entries: ScanEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.fator, (counts.get(e.fator) ?? 0) + 1);
  const total = entries.length;
  if (total === 0) return "";
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([fator, n]) => `<strong>${fator}</strong>: ${((n / total) * 100).toFixed(0)}%`)
    .join(" &nbsp;·&nbsp; ");
  return `<p class="sector-summary">Distribuição por fator de risco: ${parts}</p>`;
}

function consensoHtml(result: ScanResult): string {
  const all = [...result.top30d, ...result.top60d, ...result.top90d];
  const byTicker = new Map<string, ScanEntry[]>();
  for (const e of all) {
    const arr = byTicker.get(e.ticker) ?? [];
    arr.push(e);
    byTicker.set(e.ticker, arr);
  }

  type ConsensoItem = {
    ticker: string;
    janelas: number;
    scoreMin: number;
    knifScoreMax: number;
    entry: ScanEntry;
  };

  const consenso: ConsensoItem[] = [];
  for (const [ticker, entries] of byTicker) {
    if (entries.length < 2) continue;
    const scoreMin = Math.min(...entries.map((e) => e.score));
    const knifScoreMax = Math.max(...entries.map((e) => e.knifScore));
    // O knife score deve ser idêntico em todas as janelas (calculado uma vez).
    // Se houver divergência, é um bug: usa o max e o log já foi emitido no scan.ts.
    consenso.push({
      ticker,
      janelas: entries.length,
      scoreMin,
      knifScoreMax,
      entry: entries[0] as ScanEntry,
    });
  }
  consenso.sort((a, b) => b.janelas - a.janelas || a.scoreMin - b.scoreMin);

  if (consenso.length === 0) return "";

  // Limite de 2 por FATOR (não por setor)
  const fatorCount = new Map<string, number>();
  const limited: ConsensoItem[] = [];
  const excluded: ConsensoItem[] = [];
  for (const c of consenso) {
    const fator = c.entry.fator;
    const n = fatorCount.get(fator) ?? 0;
    if (n < 2) {
      limited.push(c);
      fatorCount.set(fator, n + 1);
    } else {
      excluded.push(c);
    }
  }

  const rows = limited
    .map(
      (c) => `<tr>
      <td><strong>${c.ticker}</strong>${near52wBadge(c.entry)}</td>
      <td>${c.entry.setor}</td>
      <td>${c.entry.fator}</td>
      <td>${c.entry.evEbit.toFixed(2)}</td>
      <td>${c.entry.pl.toFixed(2)}${jurosBadge(c.entry)}</td>
      <td>${janelasBadge(c.janelas)}</td>
      <td>${c.entry.pctAboveMin52w !== null ? `+${pct(c.entry.pctAboveMin52w, 1)}` : "—"}</td>
      <td>${knifScoreBadge(c.knifScoreMax)}</td>
    </tr>`,
    )
    .join("\n");

  const excludedNote =
    excluded.length > 0
      ? `<p class="note" style="margin-top:.5rem">Removidos por concentração de fator (&gt;2 por grupo): ${excluded.map((c) => c.ticker).join(", ")}</p>`
      : "";

  return `
  <h2>Consenso (2+ janelas)</h2>
  <p>Ações que aparecem em 2 ou 3 das 3 janelas — sinal mais robusto de underperformance relativa persistente.</p>
  ${sectorSummaryHtml(limited.map((c) => c.entry))}
  <table>
    <thead><tr>
      <th>Ticker</th><th>Setor</th><th>Fator</th><th>EV/EBIT</th><th>P/L</th><th>Janelas</th><th>↑ Mín52s</th><th>Risco</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${excludedNote}`;
}

function corporateEventsHtml(
  events: Array<{ ticker: string; setor: string; pctAboveMin52w: number }>,
): string {
  if (events.length === 0) return "";
  const rows = events
    .map(
      (e) => `<tr>
      <td><strong>${e.ticker}</strong></td>
      <td>${e.setor}</td>
      <td>+${pct(e.pctAboveMin52w, 0)}</td>
    </tr>`,
    )
    .join("\n");
  return `
  <h2>&#9888;&#65039; Dados suspeitos — possível evento corporativo</h2>
  <p class="note">Tickers com ↑ Mín52s &gt; 200%: preço atual muito acima da mínima de 52 semanas. Pode indicar grupamento ou desdobramento não ajustado no COTAHIST. <strong>Excluídos do ranking.</strong></p>
  <table>
    <thead><tr><th>Ticker</th><th>Setor</th><th>↑ Mín52s</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Gera docs/scan/index.html com os candidatos à recuperação pós circuit-breaker.
 */
export function gravarScanHtml(result: ScanResult, outPath: string): void {
  const docsDir = dirname(dirname(outPath));
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
    body { font-family: system-ui, sans-serif; max-width: 1350px; margin: 2rem auto; padding: 0 1rem; color: #222; }
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
    .sector-summary { font-size: .85rem; color: #555; margin: .5rem 0 1rem; }
    .badge { display: inline-block; font-size: .7rem; font-weight: bold; padding: .1rem .35rem; border-radius: 3px; margin-left: .3rem; vertical-align: middle; }
    .badge-red    { background: #fde8e8; color: #c00; border: 1px solid #f5c6c6; }
    .badge-orange { background: #fff3e0; color: #e65100; border: 1px solid #ffcc80; }
    .badge-green  { background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7; }
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
    Filtragem: liquidez ≥ R$1M · EV/EBIT &gt; 0 · P/L &gt; 0 · financeiras excluídas · 1 ticker por empresa · ↑ Mín52s &gt; 200% excluídos (evento corporativo).<br>
    <strong>Risco</strong> = knife score 0–7 por ticker (calculado uma única vez, independente da janela):
    (a) momentum 12-1m no decil inferior;
    (b) ≤ 5% acima da mínima de 52s;
    (c) <strong>juros↑</strong>: P/EBIT÷P/L &lt; 0,40 <em>e</em> Dív.Líq/Patrim &gt; 0,5 (não marca se P/L &gt; 50);
    (d) lucro não-recorrente: D.Y. &gt; 20% ou P/L &gt; 50;
    (e) lucro trimestral negativo ou &lt; mesmo trimestre do ano anterior (ITR CVM);
    (f) dívida líquida subiu &gt; 20% no último trimestre (ITR CVM);
    (g) último ITR recebido há &gt; 120 dias.
    Escala: <span class="badge badge-green">&#128994;</span> 0–1 &nbsp;·&nbsp; <span class="badge badge-orange">&#128993;</span> 2–3 &nbsp;·&nbsp; <span class="badge badge-red">&#128308;</span> 4+.<br>
    Consenso limitado a 2 tickers por fator de risco (Imobiliário, Varejo, etc.).
  </div>

  ${consensoHtml(result)}
  ${corporateEventsHtml(result.corporateEvents)}
  ${tableHtml(result.top30d, "30 dias", result.date30d)}
  ${tableHtml(result.top60d, "60 dias", result.date60d)}
  ${tableHtml(result.top90d, "90 dias", result.date90d)}

  <footer>Gerado em ${geradoEm} · quant-b3 · Não é recomendação de investimento.</footer>
</body>
</html>`;

  writeFileSync(outPath, html, "utf-8");
}
