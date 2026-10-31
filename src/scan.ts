import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLastPriceMap } from "./backtest/snapshot.js";
import { gravarScanHtml } from "./report/scan-html.js";
import type { ScanEntry } from "./report/scan-html.js";
import { ensureCotahistTxt } from "./sources/cotahist.js";
import { fetchFundamentus } from "./sources/fundamentus.js";
import type { RawStock } from "./types.js";

const CACHE_DIR = "data/cache";
const SCAN_HTML = join("docs", "scan", "index.html");
const LIQUIDEZ_MIN = 1_000_000;
const TOP_N = 20;

// ── Helpers de data ──────────────────────────────────────────────────────────

function todayBR(): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

function subtractDays(isoDate: string, days: number): string {
  const dt = new Date(`${isoDate}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

// ── Ranking por janela ────────────────────────────────────────────────────────

interface Candidate extends RawStock {
  liquidezMedia: number; // narrowed (never null after filter)
  evEbit: number; // narrowed
  pl: number; // narrowed
}

interface Scored extends Candidate {
  retornoStock: number;
  retornoBova: number;
  quedaRelativa: number;
  score: number;
}

function rankWindow(
  candidates: Candidate[],
  priceToday: Map<string, number>,
  priceRef: Map<string, number>,
): ScanEntry[] {
  const bovaToday = priceToday.get("BOVA11");
  const bovaRef = priceRef.get("BOVA11");
  if (!bovaToday || !bovaRef || bovaRef <= 0) return [];

  const retornoBovaPeriod = bovaToday / bovaRef - 1;

  // Computar retornos individuais
  const items: Scored[] = [];
  for (const c of candidates) {
    const p0 = priceRef.get(c.ticker);
    const p1 = priceToday.get(c.ticker);
    if (!p0 || !p1 || p0 <= 0 || p1 <= 0) continue;

    const retornoStock = p1 / p0 - 1;
    const quedaRelativa = retornoStock - retornoBovaPeriod;

    items.push({
      ...c,
      retornoStock,
      retornoBova: retornoBovaPeriod,
      quedaRelativa,
      score: 0, // calculado abaixo
    });
  }

  if (items.length === 0) return [];

  // Rank por queda relativa ascendente (mais negativa = melhor candidato)
  const byQueda = [...items].sort((a, b) => a.quedaRelativa - b.quedaRelativa);
  const rankQueda = new Map(byQueda.map((x, i) => [x.ticker, i + 1]));

  // Rank por EV/EBIT ascendente (mais barato = melhor)
  const byEvEbit = [...items].sort((a, b) => a.evEbit - b.evEbit);
  const rankEvEbit = new Map(byEvEbit.map((x, i) => [x.ticker, i + 1]));

  const scored: Scored[] = items.map((x) => ({
    ...x,
    score: (rankQueda.get(x.ticker) ?? 9999) + (rankEvEbit.get(x.ticker) ?? 9999),
  }));

  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, TOP_N)
    .map((x, i) => ({
      rank: i + 1,
      ticker: x.ticker,
      setor: x.setor,
      evEbit: x.evEbit,
      pl: x.pl,
      pvp: x.pvp,
      quedaRelativa: x.quedaRelativa,
      retornoStock: x.retornoStock,
      retornoBova: x.retornoBova,
      score: x.score,
    }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dateToday = todayBR();
  const date30d = subtractDays(dateToday, 30);
  const date60d = subtractDays(dateToday, 60);
  const date90d = subtractDays(dateToday, 90);

  console.log("=== Scan pós circuit-breaker — quant-b3 ===");
  console.log(`Hoje: ${dateToday}`);
  console.log(`Janelas: -30d=${date30d}  -60d=${date60d}  -90d=${date90d}\n`);

  // 1. Garantir COTAHIST TXTs para todos os anos necessários
  const years = new Set<number>();
  for (const d of [dateToday, date30d, date60d, date90d]) {
    const y = Number.parseInt(d.slice(0, 4), 10);
    years.add(y - 1);
    years.add(y);
  }
  console.log(`Verificando COTAHIST para anos ${[...years].sort().join(", ")}...`);
  for (const year of [...years].sort()) {
    await ensureCotahistTxt(year, CACHE_DIR);
  }
  console.log("");

  // 2. Carregar price maps para as 4 datas
  console.log("Carregando price maps...");
  const [priceToday, price30d, price60d, price90d] = await Promise.all([
    buildLastPriceMap(dateToday, CACHE_DIR),
    buildLastPriceMap(date30d, CACHE_DIR),
    buildLastPriceMap(date60d, CACHE_DIR),
    buildLastPriceMap(date90d, CACHE_DIR),
  ]);
  console.log(
    `  tickers: hoje=${priceToday.size}  -30d=${price30d.size}  -60d=${price60d.size}  -90d=${price90d.size}\n`,
  );

  // 3. Coletar fundamentals do Fundamentus
  console.log("Coletando fundamentals do Fundamentus...");
  const rawAcoesBase = await fetchFundamentus();
  console.log(`  ${rawAcoesBase.length} tickers coletados`);

  // Enriquecer setores com setor_map.json
  let setorMap: Record<string, string> = {};
  try {
    setorMap = JSON.parse(readFileSync("data/setor_map.json", "utf-8")) as Record<string, string>;
  } catch {
    /* sem mapa */
  }
  const rawAcoes = rawAcoesBase.map((a) =>
    a.setor === "Outros" && setorMap[a.ticker] ? { ...a, setor: setorMap[a.ticker] as string } : a,
  );

  // 4. Filtrar candidatos
  const candidates: Candidate[] = rawAcoes.flatMap((a) => {
    if ((a.liquidezMedia ?? 0) < LIQUIDEZ_MIN) return [];
    if (a.evEbit === null || a.evEbit <= 0) return [];
    if (a.pl === null || a.pl <= 0) return [];
    return [{ ...a, liquidezMedia: a.liquidezMedia as number, evEbit: a.evEbit, pl: a.pl }];
  });
  console.log(`  ${candidates.length} candidatos após filtros\n`);

  // 5. Rankear por janela
  console.log("Rankeando candidatos...");
  const top30d = rankWindow(candidates, priceToday, price30d);
  const top60d = rankWindow(candidates, priceToday, price60d);
  const top90d = rankWindow(candidates, priceToday, price90d);

  console.log(`  30d: ${top30d.length} candidatos`);
  console.log(`  60d: ${top60d.length} candidatos`);
  console.log(`  90d: ${top90d.length} candidatos\n`);

  // 6. Exibir top-5 de cada janela no console
  for (const [label, list] of [
    ["30d", top30d],
    ["60d", top60d],
    ["90d", top90d],
  ] as const) {
    console.log(`Top-5 janela ${label}:`);
    for (const e of list.slice(0, 5)) {
      console.log(
        `  ${e.rank}. ${e.ticker.padEnd(7)} queda_rel=${(e.quedaRelativa * 100).toFixed(2)}%  EV/EBIT=${e.evEbit.toFixed(2)}  score=${e.score}`,
      );
    }
    console.log("");
  }

  // 7. Gerar HTML
  gravarScanHtml({ dateToday, date30d, date60d, date90d, top30d, top60d, top90d }, SCAN_HTML);
  console.log(`HTML gerado em ${SCAN_HTML}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
