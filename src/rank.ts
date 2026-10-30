import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "csv-stringify/sync";
import { DEFAULT_CONFIG } from "./config.js";
import { fetchFundamentus } from "./sources/fundamentus.js";
import { enriquecerComVolMock, selectPortfolio } from "./strategy.js";

const DATA_DIR = "data/rankings";

function mesAtual(): string {
  const now = new Date();
  const tz = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = tz.find((p) => p.type === "year")?.value ?? "";
  const month = tz.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`;
}

async function main() {
  const mes = mesAtual();
  const csvPath = join(DATA_DIR, `${mes}.csv`);

  // 0. Idempotência
  if (existsSync(csvPath)) {
    console.log(`Ranking ${mes} já existe em ${csvPath}. Saindo.`);
    process.exit(0);
  }

  console.log(`Gerando ranking ${mes}...`);

  // 1. Coleta
  console.log("Coletando dados do Fundamentus...");
  const rawAcoes = await fetchFundamentus();
  console.log(`  ${rawAcoes.length} tickers coletados`);

  // 2–4. Enriquecer com volatilidade mockada (M1) e rodar estratégia
  const acoes = enriquecerComVolMock(rawAcoes);
  const resultado = selectPortfolio(acoes, DEFAULT_CONFIG);

  console.log(`  Geral: ${resultado.geral.length} ações`);
  console.log(`  Financeiras: ${resultado.financeiros.length} ações`);

  // 5. Persistir CSV
  mkdirSync(DATA_DIR, { recursive: true });

  const todasAcoes = [
    ...resultado.geral.map((a) => ({ ...a, grupo: "geral" })),
    ...resultado.financeiros.map((a) => ({ ...a, grupo: "financeiro" })),
  ];

  const csv = stringify(todasAcoes, { header: true });
  writeFileSync(csvPath, csv, "utf-8");
  console.log(`Ranking salvo em ${csvPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
