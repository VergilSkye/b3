import { runBacktest } from "./backtest/engine.js";
import { calcMetrics, formatMetrics } from "./backtest/metrics.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { Config } from "./types.js";

// Rebalanceamento semestral (abr e out) — 4 anos = 8 períodos de ~6 meses
// Lógica de DFP: dfpYear = simYear - 1 (exercício fiscal anterior)
//   out/2022 → DFP 2021 | abr/2023 → DFP 2022 | out/2023 → DFP 2022
//   abr/2024 → DFP 2023 | out/2024 → DFP 2023 | abr/2025 → DFP 2024
//   out/2025 → DFP 2024 | abr/2026 → DFP 2025
const REBALANCING_DATES = [
  "2022-10-01",
  "2023-04-01",
  "2023-10-01",
  "2024-04-01",
  "2024-10-01",
  "2025-04-01",
  "2025-10-01",
  "2026-04-01",
  "2026-10-01", // data de saída do último período
];

const PERIOD_YEARS = 0.5; // semestral
const CACHE_DIR = "data/cache";

// ── Parâmetros ajustáveis ────────────────────────────────────────────────────
const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  liquidezMin: 1_000_000, // volume médio mínimo diário (proxy COTAHIST)
  corteVol: 0.25, // remove top 25% mais voláteis
  nAcoes: 20,
  nAcoesFin: 5,
  metricas: ["evEbit", "pl"],
  metricasFin: ["pvp", "pl"],
};
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Backtest quant-b3 (semestral, 4 anos) ===");
  console.log(`Períodos: ${REBALANCING_DATES.length - 1} × 6 meses`);
  console.log(
    `Config: liquidezMin=${CONFIG.liquidezMin} corteVol=${CONFIG.corteVol} nAcoes=${CONFIG.nAcoes}+${CONFIG.nAcoesFin}`,
  );
  console.log(`Cache: ${CACHE_DIR}\n`);

  const result = await runBacktest(REBALANCING_DATES, CACHE_DIR, CACHE_DIR, CONFIG, PERIOD_YEARS);

  if (result.periods.length === 0) {
    console.error("Nenhum período completado. Verifique os arquivos de cache.");
    process.exit(1);
  }

  const metrics = calcMetrics(result);
  console.log(`\n${formatMetrics(metrics)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
