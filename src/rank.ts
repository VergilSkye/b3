import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "csv-stringify/sync";
import { DEFAULT_CONFIG } from "./config.js";
import { calcDiffResult } from "./diff.js";
import { gravarHtml } from "./report/ranking-html.js";
import { fetchFundamentus } from "./sources/fundamentus.js";
import { buildVolMap } from "./sources/prices.js";
import { buildSetorMap } from "./sources/setores.js";
import { enriquecerComVol, selectPortfolio } from "./strategy.js";

const CACHE_DIR = "data/cache";
const VOL_COVERAGE_MIN = 0.8; // 80% mínimo de tickers com volatilidade

const DATA_DIR = "data/rankings";
const DOCS_DIR = "docs";

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
  console.log("Buscando setores do Fundamentus...");
  const setorMap = await buildSetorMap(CACHE_DIR);

  console.log("Coletando dados do Fundamentus...");
  const rawAcoes = await fetchFundamentus(setorMap);
  console.log(`  ${rawAcoes.length} tickers coletados`);

  // 2. Calcular volatilidade real via COTAHIST
  // Pré-filtrar candidatos: Fundamentus inclui BDRs e FIIs que não existem no
  // COTAHIST (CODBDI=02 = ações à vista). Calcular vol só para candidatos reais
  // evita falso "baixa cobertura" causado por BDRs/FIIs na lista completa.
  const candidatos = rawAcoes.filter(
    (a) =>
      (a.liquidezMedia ?? 0) >= DEFAULT_CONFIG.liquidezMin &&
      a.pl !== null &&
      a.pl > 0 &&
      a.patLiq !== null &&
      a.patLiq > 0,
  );
  const tickersCandidatos = candidatos.map((a) => a.ticker);

  console.log(`Calculando volatilidade via COTAHIST (${tickersCandidatos.length} candidatos)...`);
  const volMap = await buildVolMap(tickersCandidatos, CACHE_DIR);

  // Verificar cobertura sobre candidatos (não sobre todos os tickers brutos)
  const comVol = tickersCandidatos.filter((t) => (volMap.get(t) ?? null) !== null).length;
  const cobertura = tickersCandidatos.length > 0 ? comVol / tickersCandidatos.length : 0;
  if (cobertura < VOL_COVERAGE_MIN) {
    throw new Error(
      `Cobertura de volatilidade insuficiente: ${(cobertura * 100).toFixed(1)}% (mínimo ${VOL_COVERAGE_MIN * 100}%)`,
    );
  }

  // 3–4. Enriquecer e rodar estratégia
  const acoes = enriquecerComVol(rawAcoes, volMap);
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

  // 6. Diff vs mês anterior
  const diff = calcDiffResult(mes, csvPath);
  if (diff.geral.entradas.length || diff.geral.saidas.length) {
    console.log(`  Entradas: ${diff.geral.entradas.join(", ")}`);
    console.log(`  Saídas:   ${diff.geral.saidas.join(", ")}`);
  }

  // 7. Gerar HTML para Pages
  gravarHtml(csvPath, mes, DATA_DIR, DOCS_DIR);
  console.log(`HTML gerado em ${DOCS_DIR}/index.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
