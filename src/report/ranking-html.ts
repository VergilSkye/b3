import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

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

function tabelaAcoes(rows: CsvRow[], metricas: string[]): string {
  const cols = [...metricas, "mom12m", "volatilidade", "liquidezMedia"];
  const cabecalho = ["#", "Ticker", "Setor", ...cols.map((m) => DISPLAY[m] ?? m), "Score"]
    .map((h) => `<th>${h}</th>`)
    .join("");

  const linhas = rows
    .map((r, i) => {
      const cells = cols.map((m) => `<td>${fmt(m, r[m])}</td>`).join("");
      return `<tr><td>${i + 1}</td><td><b>${r.ticker}</b></td><td>${r.setor}</td>${cells}<td>${r.score}</td></tr>`;
    })
    .join("\n");

  return `<table><thead><tr>${cabecalho}</tr></thead><tbody>\n${linhas}\n</tbody></table>`;
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

export function gerarHtml(csvPath: string, mes: string, dataDir: string): string {
  const content = readFileSync(csvPath, "utf-8");
  const rows = parse(content, { columns: true, skip_empty_lines: true }) as CsvRow[];

  const gerais = rows.filter((r) => r.grupo === "geral");
  const financeiras = rows.filter((r) => r.grupo === "financeiro");
  const historicoGeral = carregarHistorico(dataDir, "geral");

  // Usar construtor local (year, month, day) evita o bug de UTC:
  // new Date("2026-10-01") = meia-noite UTC = 30/09 em UTC-3 → "setembro"
  const [anoStr, mesStr] = mes.split("-");
  const mesLabel = new Date(Number(anoStr), Number(mesStr) - 1, 1).toLocaleString("pt-BR", {
    month: "long",
    year: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ranking B3 — ${mesLabel}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { border-bottom: 2px solid #333; padding-bottom: .5rem; }
    h2 { margin-top: 2rem; color: #444; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: .5rem .75rem; border: 1px solid #ddd; text-align: left; }
    thead tr { background: #f4f4f4; }
    tbody tr:nth-child(even) { background: #fafafa; }
    footer { margin-top: 3rem; font-size: .8rem; color: #888; }
  </style>
</head>
<body>
  <h1>Ranking B3 — ${mesLabel}</h1>
  <p><em>Estratégia quantitativa de valor. Não é recomendação de investimento.</em></p>

  <h2>Top geral — EV/EBIT + P/L</h2>
  ${tabelaAcoes(gerais, ["evEbit", "pl"])}

  ${
    financeiras.length > 0
      ? `<h2>Financeiras — P/VP + P/L</h2>\n  ${tabelaAcoes(financeiras, ["pvp", "pl"])}`
      : ""
  }

  ${historicoHtml(historicoGeral)}

  <footer>Gerado em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · quant-b3</footer>
</body>
</html>`;
}

export function gravarHtml(csvPath: string, mes: string, dataDir: string, docsDir: string): void {
  mkdirSync(docsDir, { recursive: true });
  const html = gerarHtml(csvPath, mes, dataDir);
  writeFileSync(join(docsDir, "index.html"), html, "utf-8");
}
