import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { DiffResult } from "./diff.js";
import { calcDiffResult, ultimoCsv } from "./diff.js";

interface CsvRow {
  ticker: string;
  grupo: string;
  score: string;
  pl: string;
  evEbit: string;
  pvp: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linhaAcao(pos: number, row: CsvRow): string {
  return `${pos}. <b>${esc(row.ticker)}</b>  score ${row.score}`;
}

function secaoDiff(diff: DiffResult): string {
  const linhas: string[] = [];
  const entradas = [...diff.geral.entradas, ...diff.financeiros.entradas];
  const saidas = [...diff.geral.saidas, ...diff.financeiros.saidas];
  if (entradas.length === 0 && saidas.length === 0) return "";
  linhas.push("\n<b>Mudancas</b>");
  for (const t of entradas) linhas.push(`  ↑ ${esc(t)}`);
  for (const t of saidas) linhas.push(`  ↓ ${esc(t)}`);
  return linhas.join("\n");
}

export function buildMensagem(
  csvPath: string,
  mes: string,
  diff: DiffResult,
  pageUrl = "",
): string {
  const content = readFileSync(csvPath, "utf-8");
  const rows = parse(content, { columns: true, skip_empty_lines: true }) as CsvRow[];

  const gerais = rows.filter((r) => r.grupo === "geral");
  const financeiras = rows.filter((r) => r.grupo === "financeiro");

  const [ano, mesNum] = mes.split("-");
  const mesLabel = new Date(`${ano}-${mesNum}-01`).toLocaleString("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  });

  const linhas: string[] = [];
  linhas.push(`<b>Ranking B3 — ${mesLabel}</b>\n`);

  linhas.push("<b>Top geral (EV/EBIT + P/L)</b>");
  gerais.forEach((r, i) => linhas.push(linhaAcao(i + 1, r)));

  if (financeiras.length > 0) {
    linhas.push("\n<b>Financeiras (P/VP + P/L)</b>");
    financeiras.forEach((r, i) => linhas.push(linhaAcao(i + 1, r)));
  }

  linhas.push(secaoDiff(diff));

  if (pageUrl) linhas.push(`\n<a href="${pageUrl}">Ver pagina completa</a>`);

  return linhas.filter((l) => l !== "").join("\n");
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

async function main() {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_TOKEN e TELEGRAM_CHAT_ID são obrigatórios");

  const latest = ultimoCsv();
  if (!latest) throw new Error("Nenhum CSV encontrado em data/rankings/");

  const diff = calcDiffResult(latest.mes, latest.path);
  const pageUrl = process.env.PAGES_URL ?? "";
  const texto = buildMensagem(latest.path, latest.mes, diff, pageUrl);

  console.log("Enviando mensagem ao Telegram...");
  await sendTelegram(token, chatId, texto);
  console.log("Enviado.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
