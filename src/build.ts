/**
 * pnpm build — reconstrói todas as páginas HTML a partir de dados locais,
 * sem acesso à rede e sem reparsar COTAHIST/CVM.
 *
 * O que faz:
 *   1. Ranking: lê o CSV mais recente de data/rankings/ e regenera docs/index.html
 *   2. Backtest/Scan: já foram gerados pelos respectivos scripts; apenas reporta
 *      a data de última modificação de cada arquivo em docs/.
 *
 * Use quando quiser atualizar a navegação ou corrigir o HTML sem rodar pnpm rank.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gravarHtml } from "./report/ranking-html.js";

const DATA_DIR = "data/rankings";
const DOCS_DIR = "docs";

function latestCsv(): { path: string; mes: string } | null {
  if (!existsSync(DATA_DIR)) return null;
  const files = readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
    .sort()
    .reverse();
  if (!files[0]) return null;
  return { path: join(DATA_DIR, files[0]), mes: files[0].replace(".csv", "") };
}

function mtime(path: string): string {
  try {
    return statSync(path).mtime.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "–";
  }
}

function status(path: string): string {
  return existsSync(path) ? `✓  ${mtime(path)}` : "✗  não gerado";
}

async function main() {
  console.log("=== pnpm build — quant-b3 ===\n");

  // 1. Ranking
  const latest = latestCsv();
  if (!latest) {
    console.error("✗  Nenhum CSV em data/rankings/ — rode pnpm rank primeiro.");
    process.exit(1);
  }
  console.log(`Ranking: ${latest.mes} → docs/index.html`);
  gravarHtml(latest.path, latest.mes, DATA_DIR, DOCS_DIR);
  console.log("  ✓  gerado\n");

  // 2. Relatório de status das demais páginas
  const pages = [
    { label: "Backtest ", path: join(DOCS_DIR, "backtest", "index.html") },
    { label: "Scan CB  ", path: join(DOCS_DIR, "scan", "index.html") },
  ];

  console.log("Outras páginas (geradas pelos scripts respectivos):");
  for (const p of pages) {
    console.log(`  ${p.label}  ${status(p.path)}`);
  }

  console.log("\nDone. Abra docs/index.html ou publique com git push.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
