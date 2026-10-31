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
  knifScore: number; // 0–7 pontos de risco
  score: number;
  janelas: number;
  priceAtual: number | null; // fechamento mais recente (COTAHIST)
  vol: number | null; // volatilidade anualizada (ex.: 0.60 = 60%)
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
      <td>${e.priceAtual !== null ? fmtBRL(e.priceAtual) : "—"}</td>
      <td>${e.vol !== null ? `${(e.vol * 100).toFixed(0)}%` : "—"}</td>
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
      <th>EV/EBIT</th><th>P/L</th><th>P/VP</th><th>Preço</th><th>σ</th>
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

  // ── Calculadora de posição ──────────────────────────────────────────────────
  const defaultWeight = limited.length > 0 ? Math.round(100 / limited.length) : 20;

  const calcRows = limited
    .map((c) => {
      const e = c.entry;
      const priceVal = e.priceAtual !== null ? e.priceAtual.toFixed(2) : "";
      const volVal = e.vol !== null ? (e.vol * 100).toFixed(0) : "";
      return `<tr>
      <td><strong>${e.ticker}</strong>${near52wBadge(e)}${jurosBadge(e)}</td>
      <td><input class="inp-price" type="number" step="0.01" value="${priceVal}" style="width:5.5em"></td>
      <td><input class="inp-vol" type="number" step="1" value="${volVal}" min="1" max="300" style="width:3.5em">%</td>
      <td><input class="inp-weight" type="number" step="5" value="${defaultWeight}" min="0" max="100" style="width:3.5em">%</td>
      <td class="calc-qty1">\u2014</td>
      <td class="calc-buy2">\u2014</td>
      <td class="calc-qty2">\u2014</td>
      <td class="calc-t1">\u2014</td>
      <td class="calc-t2">\u2014</td>
      <td class="calc-stop">\u2014</td>
      <td>${knifScoreBadge(c.knifScoreMax)}</td>
    </tr>`;
    })
    .join("\n");

  const calcJs = `<script>
(function(){
  function fmt(v){
    if(!v||isNaN(v)||v===0)return'\u2014';
    return'R\u00a0'+v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  }
  function recalc(){
    var cap=parseFloat(document.getElementById('calc-cap').value)||0;
    var periodo=parseInt(document.getElementById('calc-periodo').value)||90;
    var d=new Date(Date.now()+periodo*86400000);
    document.getElementById('calc-fim').textContent=d.toLocaleDateString('pt-BR');
    var totalW=0;
    document.querySelectorAll('#calc-table .inp-weight').forEach(function(el){totalW+=parseFloat(el.value)||0;});
    var wEl=document.getElementById('calc-total-w');
    if(wEl){wEl.textContent=totalW.toFixed(0)+'%';wEl.style.color=Math.abs(totalW-100)>1?'#c00':'#080';}
    document.querySelectorAll('#calc-table tbody tr').forEach(function(tr){
      var price=parseFloat(tr.querySelector('.inp-price').value);
      var volPct=parseFloat(tr.querySelector('.inp-vol').value);
      var weight=(parseFloat(tr.querySelector('.inp-weight').value)||0)/100;
      if(!price||isNaN(price)||price<=0||!volPct||isNaN(volPct)){
        ['.calc-buy2','.calc-t1','.calc-t2','.calc-stop','.calc-qty1','.calc-qty2'].forEach(function(s){
          var el=tr.querySelector(s);if(el)el.textContent='\u2014';
        });
        return;
      }
      var vol=volPct/100;
      var sig30d=vol*0.29;var sig90d=vol*0.5;
      var buy2=price*(1-0.5*sig30d);
      var t1=price*(1+0.5*sig90d);
      var t2=price*(1+sig90d);
      var stop=price*(1-0.5*sig90d);
      tr.querySelector('.calc-buy2').textContent=fmt(buy2);
      tr.querySelector('.calc-t1').textContent=fmt(t1);
      tr.querySelector('.calc-t2').textContent=fmt(t2);
      tr.querySelector('.calc-stop').textContent=fmt(stop);
      var alloc=cap*weight;
      var q1=alloc>0&&price>0?Math.floor(alloc/2/price):0;
      var q2=alloc>0&&buy2>0?Math.floor(alloc/2/buy2):0;
      tr.querySelector('.calc-qty1').textContent=q1>0?String(q1):'\u2014';
      tr.querySelector('.calc-qty2').textContent=q2>0?String(q2):'\u2014';
    });
  }
  function listen(sel){document.querySelectorAll(sel).forEach(function(el){el.addEventListener('input',recalc);});}
  document.getElementById('calc-cap').addEventListener('input',recalc);
  document.getElementById('calc-periodo').addEventListener('input',recalc);
  listen('#calc-table .inp-price');
  listen('#calc-table .inp-vol');
  listen('#calc-table .inp-weight');
  recalc();
})();
<\/script>`;

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
  ${excludedNote}

  <h2>Calculadora de posição — consenso</h2>
  <p class="note">
    Preço e σ pré-preenchidos com dados do COTAHIST (editáveis para ajuste).<br>
    <strong>Fórmulas (σ&nbsp;anual):</strong>
    B2&nbsp;=&nbsp;P&times;(1&minus;0,145σ) &nbsp;&middot;&nbsp;
    A1&nbsp;=&nbsp;P&times;(1&plus;0,25σ) &nbsp;&middot;&nbsp;
    A2&nbsp;=&nbsp;P&times;(1&plus;0,5σ) &nbsp;&middot;&nbsp;
    Stop&nbsp;=&nbsp;P&times;(1&minus;0,25σ).<br>
    Capital dividido em 2 etapas: 50% na Compra 1 (preço atual) e 50% na Compra 2 (se cair).
    Use fracionário (ticker&nbsp;+&nbsp;F) com ordem limitada.
  </p>
  <div class="calc-controls">
    Capital:&nbsp;R$&nbsp;<input id="calc-cap" type="number" value="3500" step="500" min="0" style="width:6em">
    &nbsp;&nbsp;Per&iacute;odo:&nbsp;<input id="calc-periodo" type="number" value="90" step="10" min="1" max="365" style="width:4em">&nbsp;dias
    &nbsp;&nbsp;Fim:&nbsp;<strong id="calc-fim"></strong>
    &nbsp;&nbsp;Peso&nbsp;&Sigma;:&nbsp;<strong id="calc-total-w"></strong>
  </div>
  <div style="overflow-x:auto">
  <table id="calc-table">
    <thead><tr>
      <th>Ticker</th><th>Pre&ccedil;o</th><th>&#963;</th><th>Peso&nbsp;%</th>
      <th>Qtd&nbsp;B1</th><th>Compra&nbsp;2</th><th>Qtd&nbsp;B2</th>
      <th>Alvo&nbsp;1</th><th>Alvo&nbsp;2</th><th style="color:#c00">Stop</th><th>Risco</th>
    </tr></thead>
    <tbody>${calcRows}</tbody>
  </table>
  </div>
  ${calcJs}`;
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
    .calc-controls { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin: .75rem 0 1rem; font-size: .9rem; }
    .calc-controls input[type=number] { border: 1px solid #bbb; border-radius: 3px; padding: .2rem .35rem; font-size: .875rem; }
    #calc-table input[type=number] { border: 1px solid #bbb; border-radius: 3px; padding: .15rem .3rem; font-size: .8rem; }
    .calc-stop { color: #c00; font-weight: bold; }
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
