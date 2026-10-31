import { join } from "node:path";
import type { PeriodResult } from "./backtest/engine.js";
import { calcMetrics, formatMetrics } from "./backtest/metrics.js";
import { buildLastPriceMap, buildSnapshot } from "./backtest/snapshot.js";
import { DEFAULT_CONFIG } from "./config.js";
import { gravarBacktestHtml } from "./report/backtest-html.js";
import type { GridEntry } from "./report/backtest-html.js";
import { ensureCotahistTxt } from "./sources/cotahist.js";
import { enriquecerComVol, selectPortfolio } from "./strategy.js";
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
const BACKTEST_HTML = join("docs", "backtest", "index.html");

// ── Configuração base ────────────────────────────────────────────────────────
const BASE_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  liquidezMin: 1_000_000,
  corteVol: 0.25,
  nAcoes: 20,
  nAcoesFin: 5,
  metricas: ["evEbit", "pl"],
  metricasFin: ["pvp", "pl"],
};

// ── Grid de parâmetros ───────────────────────────────────────────────────────
const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6"];

interface GridCfg {
  label: string;
  overrides: Partial<Config>;
  isBase?: true;
}

const GRID: GridCfg[] = [
  { label: "n=20 vol=25%", overrides: {}, isBase: true },
  { label: "n=15 vol=25%", overrides: { nAcoes: 15 } },
  { label: "n=25 vol=25%", overrides: { nAcoes: 25 } },
  { label: "n=20 vol=0%", overrides: { corteVol: 0 } },
  { label: "n=20 vol=50%", overrides: { corteVol: 0.5 } },
  { label: "n=20 só EV/EBIT", overrides: { metricas: ["evEbit"] } },
  { label: "n=20 só P/L", overrides: { metricas: ["pl"] } },
];
// ─────────────────────────────────────────────────────────────────────────────

const isGrid = process.argv.includes("--grid");

type SnapshotCache = Awaited<ReturnType<typeof buildSnapshot>>;

async function runConfig(
  cfg: Config,
  snapshotCache: Map<string, SnapshotCache>,
  priceCache: Map<string, Map<string, number>>,
): Promise<PeriodResult[]> {
  const periods: PeriodResult[] = [];

  for (let i = 0; i < REBALANCING_DATES.length - 1; i++) {
    const startDate = REBALANCING_DATES[i] as string;
    const endDate = REBALANCING_DATES[i + 1] as string;

    const snap = snapshotCache.get(startDate);
    if (!snap) continue;

    const acoes = enriquecerComVol(snap.rawAcoes, snap.volMap);
    const resultado = selectPortfolio(acoes, cfg);

    const selecionados = [
      ...resultado.geral.map((a) => a.ticker),
      ...resultado.financeiros.map((a) => a.ticker),
    ];

    if (selecionados.length === 0) continue;

    const pricesT0 = priceCache.get(startDate) ?? new Map<string, number>();
    const pricesT1 = priceCache.get(endDate) ?? new Map<string, number>();

    const retornos: number[] = [];
    for (const ticker of selecionados) {
      const p0 = pricesT0.get(ticker);
      const p1 = pricesT1.get(ticker);
      if (p0 && p0 > 0 && p1 && p1 > 0) retornos.push(p1 / p0 - 1);
    }

    const portfolioReturn =
      retornos.length > 0 ? retornos.reduce((s, r) => s + r, 0) / retornos.length : 0;

    const b0 = pricesT0.get("BOVA11");
    const b1 = pricesT1.get("BOVA11");
    const benchmarkReturn = b0 && b0 > 0 && b1 && b1 > 0 ? b1 / b0 - 1 : null;

    periods.push({
      startDate,
      endDate,
      portfolio: selecionados,
      portfolioReturn,
      benchmarkReturn,
      nGeral: resultado.geral.length,
      nFin: resultado.financeiros.length,
    });
  }

  return periods;
}

async function main() {
  if (isGrid) {
    console.log("=== Backtest quant-b3 — Grid de parâmetros ===");
  } else {
    console.log("=== Backtest quant-b3 (semestral, 4 anos) ===");
  }
  console.log(`Períodos: ${REBALANCING_DATES.length - 1} × 6 meses\n`);

  // 1. Garantir que todos os TXTs do COTAHIST existem (download+extração se necessário)
  const cotahistYears = new Set<number>();
  for (const date of REBALANCING_DATES) {
    const y = Number.parseInt(date.slice(0, 4), 10);
    cotahistYears.add(y - 1);
    cotahistYears.add(y);
  }
  console.log(`Verificando COTAHIST para anos ${[...cotahistYears].sort().join(", ")}...`);
  for (const year of [...cotahistYears].sort()) {
    await ensureCotahistTxt(year, CACHE_DIR);
  }
  console.log("");

  // 3. Pré-cachear snapshots (uma vez por data)
  console.log("Carregando snapshots...");
  const snapshotCache = new Map<string, SnapshotCache>();
  for (const date of REBALANCING_DATES.slice(0, -1)) {
    console.log(`  snapshot ${date}`);
    snapshotCache.set(date, await buildSnapshot(date, CACHE_DIR, CACHE_DIR));
  }

  // 4. Pré-cachear price maps (uma vez por data, todas as datas)
  console.log("\nCarregando price maps...");
  const priceCache = new Map<string, Map<string, number>>();
  for (const date of REBALANCING_DATES) {
    priceCache.set(date, await buildLastPriceMap(date, CACHE_DIR));
  }
  console.log("");

  if (!isGrid) {
    // Modo simples: rodar só a config base
    const periods = await runConfig(BASE_CONFIG, snapshotCache, priceCache);

    if (periods.length === 0) {
      console.error("Nenhum período completado. Verifique os arquivos de cache.");
      process.exit(1);
    }

    const result = { periods, config: BASE_CONFIG, periodYears: PERIOD_YEARS };
    const metrics = calcMetrics(result);
    console.log(`\n${formatMetrics(metrics)}`);

    const entries: GridEntry[] = [
      {
        label: "base (n=20, vol=25%, EV/EBIT+P/L)",
        color: PALETTE[0] as string,
        metrics,
        isBase: true,
      },
    ];
    gravarBacktestHtml(entries, BACKTEST_HTML);
    console.log(`\nHTML gerado em ${BACKTEST_HTML}`);
    return;
  }

  // Modo grid: rodar todas as configs
  console.log(`Grid: ${GRID.length} configurações\n`);
  const entries: GridEntry[] = [];

  for (let gi = 0; gi < GRID.length; gi++) {
    const gc = GRID[gi] as GridCfg;
    const cfg: Config = { ...BASE_CONFIG, ...gc.overrides };
    console.log(`[${gi + 1}/${GRID.length}] ${gc.label}`);

    const periods = await runConfig(cfg, snapshotCache, priceCache);
    if (periods.length === 0) {
      console.warn("  sem períodos — pulando");
      continue;
    }

    const result = { periods, config: cfg, periodYears: PERIOD_YEARS };
    const metrics = calcMetrics(result);

    console.log(
      `  CAGR=${(metrics.cagr * 100).toFixed(2)}%  Sharpe=${metrics.sharpe?.toFixed(2) ?? "n/a"}  DD=${(metrics.maxDrawdown * 100).toFixed(2)}%`,
    );

    entries.push({
      label: gc.label,
      color: PALETTE[gi % PALETTE.length] as string,
      metrics,
      ...(gc.isBase ? { isBase: true as const } : {}),
    });
  }

  gravarBacktestHtml(entries, BACKTEST_HTML);
  console.log(`\nHTML gerado em ${BACKTEST_HTML}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
