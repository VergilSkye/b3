import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { NAV_CSS, htmlMtime, navHtml } from "./nav.js";

interface CsvRow {
  ticker: string;
  grupo: string;
  score: string;
  pl: string;
  evEbit: string;
  pvp: string;
  setor: string;
  [key: string]: string;
}

interface HistoricoEntry {
  mes: string;
  tickers: string[];
}

function carregarHistorico(dataDir: string, grupoFiltro: string): HistoricoEntry[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
    .sort()
    .slice(-6) // últimos 6 meses
    .map((f) => {
      const content = readFileSync(join(dataDir, f), "utf-8");
      const rows = parse(content, { columns: true, skip_empty_lines: true }) as CsvRow[];
      return {
        mes: f.replace(".csv", ""),
        tickers: rows.filter((r) => r.grupo === grupoFiltro).map((r) => r.ticker),
      };
    });
}

const DISPLAY: Record<string, string> = {
  evEbit: "EV/EBIT",
  pl: "P/L",
  pvp: "P/VP",
  roe: "ROE",
  volatilidade: "Vol12m",
  mom12m: "Mom12m",
  liquidezMedia: "Liq2m (R$)",
};

function fmt(campo: string, valor: string | undefined): string {
  if (valor == null || valor === "") return "-";
  if (campo === "liquidezMedia") {
    const n = Number(valor);
    if (!Number.isFinite(n)) return valor;
    return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : valor;
  }
  if (campo === "volatilidade") return `${(Number(valor) * 100).toFixed(1)}%`;
  if (campo === "mom12m") return `${(Number(valor) * 100).toFixed(1)}%`;
  return valor;
}

function tabelaAcoes(rows: CsvRow[], metricas: string[], calcId: string): string {
  const cols = [...metricas, "mom12m", "volatilidade", "liquidezMedia"];
  const cabecalho = [
    "#",
    "Ticker",
    "Setor",
    ...cols.map((m) => DISPLAY[m] ?? m),
    "Pre&ccedil;o",
    "Qtd&nbsp;B1",
    "Compra&nbsp;2",
    "Qtd&nbsp;B2",
    "Alvo&nbsp;1",
    "Alvo&nbsp;2",
    "<span style='color:#c00'>Stop</span>",
    "Score",
  ]
    .map((h) => `<th>${h}</th>`)
    .join("");

  const linhas = rows
    .map((r, i) => {
      const cells = cols.map((m) => `<td>${fmt(m, r[m])}</td>`).join("");
      const volRaw = r.volatilidade ?? "";
      return `<tr data-vol="${volRaw}">
        <td>${i + 1}</td><td><b>${r.ticker}</b></td><td>${r.setor}</td>
        ${cells}
        <td><input class="rk-inp-price" type="number" step="0.01" placeholder="—" title="Informe o pre&ccedil;o atual" style="width:5.5em"></td>
        <td class="rk-qty1">\u2014</td>
        <td class="rk-buy2">\u2014</td>
        <td class="rk-qty2">\u2014</td>
        <td class="rk-t1">\u2014</td>
        <td class="rk-t2">\u2014</td>
        <td class="rk-stop">\u2014</td>
        <td>${r.score}</td>
      </tr>`;
    })
    .join("\n");

  return `<div style="overflow-x:auto"><table data-calc="${calcId}"><thead><tr>${cabecalho}</tr></thead><tbody>\n${linhas}\n</tbody></table></div>`;
}

function calcRankingJs(): string {
  return `<script>
(function(){
  function fmt(v){
    if(!v||isNaN(v)||v===0)return'\u2014';
    return'R\u00a0'+v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  }
  function recalcTable(table,cap){
    table.querySelectorAll('tbody tr').forEach(function(tr){
      var price=parseFloat(tr.querySelector('.rk-inp-price').value);
      var volRaw=parseFloat(tr.dataset.vol)||0;
      if(!price||isNaN(price)||price<=0||volRaw<=0){
        ['.rk-buy2','.rk-t1','.rk-t2','.rk-stop','.rk-qty1','.rk-qty2'].forEach(function(s){
          var el=tr.querySelector(s);if(el)el.textContent='\u2014';
        });
        return;
      }
      var vol=volRaw;
      var sig30d=vol*0.29;var sig90d=vol*0.5;
      var buy2=price*(1-0.5*sig30d);
      var t1=price*(1+0.5*sig90d);
      var t2=price*(1+sig90d);
      var stop=price*(1-0.5*sig90d);
      tr.querySelector('.rk-buy2').textContent=fmt(buy2);
      tr.querySelector('.rk-t1').textContent=fmt(t1);
      tr.querySelector('.rk-t2').textContent=fmt(t2);
      tr.querySelector('.rk-stop').textContent=fmt(stop);
      var n=table.querySelectorAll('tbody tr').length;
      var alloc=n>0?cap/n:0;
      var q1=alloc>0&&price>0?Math.floor(alloc/2/price):0;
      var q2=alloc>0&&buy2>0?Math.floor(alloc/2/buy2):0;
      tr.querySelector('.rk-qty1').textContent=q1>0?String(q1):'\u2014';
      tr.querySelector('.rk-qty2').textContent=q2>0?String(q2):'\u2014';
    });
  }
  function recalc(){
    var cap=parseFloat(document.getElementById('rk-cap').value)||0;
    document.querySelectorAll('table[data-calc]').forEach(function(t){recalcTable(t,cap);});
  }
  document.getElementById('rk-cap').addEventListener('input',recalc);
  document.querySelectorAll('.rk-inp-price').forEach(function(el){el.addEventListener('input',recalc);});
  recalc();
})();
<\/script>`;
}

function historicoHtml(historico: HistoricoEntry[]): string {
  if (historico.length === 0) return "";
  return `
<h2>Histórico (últimos 6 meses)</h2>
<table>
  <thead><tr><th>Mês</th><th>Carteira</th></tr></thead>
  <tbody>
    ${historico
      .map((e) => `<tr><td>${e.mes}</td><td>${e.tickers.join(", ")}</td></tr>`)
      .join("\n    ")}
  </tbody>
</table>`;
}

export function gerarHtml(csvPath: string, mes: string, dataDir: string, docsDir: string): string {
  const content = readFileSync(csvPath, "utf-8");
  const rows = parse(content, { columns: true, skip_empty_lines: true }) as CsvRow[];

  const gerais = rows.filter((r) => r.grupo === "geral");
  const financeiras = rows.filter((r) => r.grupo === "financeiro");
  const historicoGeral = carregarHistorico(dataDir, "geral");

  // Usar construtor local (year, month, day) evita o bug de UTC
  const [anoStr, mesStr] = mes.split("-");
  const mesLabel = new Date(Number(anoStr), Number(mesStr) - 1, 1).toLocaleString("pt-BR", {
    month: "long",
    year: "numeric",
  });

  const geradoEm = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const dates: Partial<Record<"backtest" | "scan", string>> = {};
  const btDate = htmlMtime(join(docsDir, "backtest", "index.html"));
  const scDate = htmlMtime(join(docsDir, "scan", "index.html"));
  if (btDate) dates.backtest = btDate;
  if (scDate) dates.scan = scDate;
  const nav = navHtml("ranking", dates);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ranking B3 — ${mesLabel}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { padding-bottom: .5rem; margin-bottom: 0; }
    h2 { margin-top: 2rem; color: #444; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: .5rem .75rem; border: 1px solid #ddd; text-align: left; white-space: nowrap; }
    thead tr { background: #f4f4f4; }
    tbody tr:nth-child(even) { background: #fafafa; }
    footer { margin-top: 3rem; font-size: .8rem; color: #888; }
    .calc-controls { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.75rem 0 1rem; font-size:.9rem; }
    .calc-controls input[type=number] { border:1px solid #bbb; border-radius:3px; padding:.2rem .35rem; font-size:.875rem; }
    .rk-inp-price { border:1px solid #bbb; border-radius:3px; padding:.15rem .3rem; font-size:.8rem; }
    .rk-stop { color:#c00; font-weight:bold; }
    ${NAV_CSS}
  </style>
</head>
<body>
  ${nav}
  <h1>Ranking B3 — ${mesLabel}</h1>
  <p><em>Estratégia quantitativa de valor. Não é recomendação de investimento.</em></p>

  <div class="calc-controls">
    <strong>Calculadora de posi&ccedil;&atilde;o</strong> &nbsp;
    Capital:&nbsp;R$&nbsp;<input id="rk-cap" type="number" value="10000" step="500" min="0" style="width:7em">
    <span style="font-size:.8rem;color:#666">Informe o pre&ccedil;o atual de cada a&ccedil;&atilde;o para calcular n&iacute;veis e quantidades (peso igual entre todos os tickers do grupo).</span>
  </div>

  <h2>Top geral — EV/EBIT + P/L</h2>
  ${tabelaAcoes(gerais, ["evEbit", "pl"], "geral")}

  ${
    financeiras.length > 0
      ? `<h2>Financeiras — P/VP + P/L</h2>\n  ${tabelaAcoes(financeiras, ["pvp", "pl"], "fin")}`
      : ""
  }

  ${historicoHtml(historicoGeral)}

  ${calcRankingJs()}

  <footer>Gerado em ${geradoEm} · quant-b3 · Não é recomendação de investimento.</footer>
</body>
</html>`;
}

export function gravarHtml(csvPath: string, mes: string, dataDir: string, docsDir: string): void {
  mkdirSync(docsDir, { recursive: true });
  const html = gerarHtml(csvPath, mes, dataDir, docsDir);
  writeFileSync(join(docsDir, "index.html"), html, "utf-8");
}
