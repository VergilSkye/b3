import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildScanPriceMaps } from "./backtest/snapshot.js";
import { isFinanceira } from "./config.js";
import { gravarScanHtml } from "./report/scan-html.js";
import type { ScanEntry } from "./report/scan-html.js";
import { ensureCotahistTxt } from "./sources/cotahist.js";
import { fetchFundamentus } from "./sources/fundamentus.js";
import type { RawStock } from "./types.js";

const CACHE_DIR = "data/cache";
const SCAN_HTML = join("docs", "scan", "index.html");
const LIQUIDEZ_MIN = 1_000_000;
const TOP_N = 20;
const NEAR_MIN52W_THRESHOLD = 0.15; // badge "~Mín52s" se dentro de 15%

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

// ── Candidatos ───────────────────────────────────────────────────────────────

interface Candidate extends RawStock {
  liquidezMedia: number;
  evEbit: number;
  pl: number;
}

// ── Ranking por janela ────────────────────────────────────────────────────────

function rankWindow(
  candidates: Candidate[],
  priceToday: Map<string, number>,
  priceRef: Map<string, number>,
  low52w: Map<string, number>,
): Omit<ScanEntry, "janelas">[] {
  const bovaToday = priceToday.get("BOVA11");
  const bovaRef = priceRef.get("BOVA11");
  if (!bovaToday || !bovaRef || bovaRef <= 0) return [];

  const retornoBovaPeriod = bovaToday / bovaRef - 1;

  // Computar retornos individuais
  type Item = Omit<ScanEntry, "janelas"> & { score: number };
  const items: Item[] = [];
  for (const c of candidates) {
    const p0 = priceRef.get(c.ticker);
    const p1 = priceToday.get(c.ticker);
    if (!p0 || !p1 || p0 <= 0 || p1 <= 0) continue;

    const retornoStock = p1 / p0 - 1;
    const quedaRelativa = retornoStock - retornoBovaPeriod;

    const low = low52w.get(c.ticker);
    const pctAboveMin52w = low && low > 0 ? p1 / low - 1 : null;

    items.push({
      rank: 0,
      ticker: c.ticker,
      setor: c.setor,
      evEbit: c.evEbit,
      pl: c.pl,
      pvp: c.pvp,
      retornoStock,
      retornoBova: retornoBovaPeriod,
      quedaRelativa,
      pctAboveMin52w,
      score: 0,
    });
  }

  if (items.length === 0) return [];

  // Rank por queda relativa ascendente (mais negativa = melhor candidato)
  const byQueda = [...items].sort((a, b) => a.quedaRelativa - b.quedaRelativa);
  const rankQueda = new Map(byQueda.map((x, i) => [x.ticker, i + 1]));

  // Rank por EV/EBIT ascendente (mais barato = melhor)
  const byEvEbit = [...items].sort((a, b) => a.evEbit - b.evEbit);
  const rankEvEbit = new Map(byEvEbit.map((x, i) => [x.ticker, i + 1]));

  const scored: Item[] = items.map((x) => ({
    ...x,
    score: (rankQueda.get(x.ticker) ?? 9999) + (rankEvEbit.get(x.ticker) ?? 9999),
  }));

  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, TOP_N)
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

function attachJanelas(
  entries30d: Omit<ScanEntry, "janelas">[],
  entries60d: Omit<ScanEntry, "janelas">[],
  entries90d: Omit<ScanEntry, "janelas">[],
): { top30d: ScanEntry[]; top60d: ScanEntry[]; top90d: ScanEntry[] } {
  const count = new Map<string, number>();
  for (const e of [...entries30d, ...entries60d, ...entries90d]) {
    count.set(e.ticker, (count.get(e.ticker) ?? 0) + 1);
  }
  const add = (e: Omit<ScanEntry, "janelas">): ScanEntry => ({
    ...e,
    janelas: count.get(e.ticker) ?? 1,
  });
  return {
    top30d: entries30d.map(add),
    top60d: entries60d.map(add),
    top90d: entries90d.map(add),
  };
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

  // 1. Garantir COTAHIST TXTs
  const years = new Set<number>();
  for (const d of [dateToday, date90d]) {
    const y = Number.parseInt(d.slice(0, 4), 10);
    years.add(y - 1);
    years.add(y);
  }
  console.log(`Verificando COTAHIST para anos ${[...years].sort().join(", ")}...`);
  for (const year of [...years].sort()) {
    await ensureCotahistTxt(year, CACHE_DIR);
  }
  console.log("");

  // 2. Carregar todos os price maps em um único pass do COTAHIST
  console.log("Carregando price maps (pass único do COTAHIST)...");
  const { priceToday, price30d, price60d, price90d, low52w } = await buildScanPriceMaps(
    dateToday,
    date30d,
    date60d,
    date90d,
    CACHE_DIR,
  );
  console.log(
    `  tickers: hoje=${priceToday.size}  -30d=${price30d.size}  -60d=${price60d.size}  -90d=${price90d.size}  low52w=${low52w.size}\n`,
  );

  // 3. Coletar fundamentals
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

  // 4. Filtrar candidatos — excluir financeiras (têm EV/EBIT=null, métricas diferentes)
  const candidates: Candidate[] = rawAcoes.flatMap((a) => {
    if (isFinanceira(a.setor)) return []; // ranking separado; EV/EBIT não se aplica
    if ((a.liquidezMedia ?? 0) < LIQUIDEZ_MIN) return [];
    if (a.evEbit === null || a.evEbit <= 0) return [];
    if (a.pl === null || a.pl <= 0) return [];
    return [{ ...a, liquidezMedia: a.liquidezMedia as number, evEbit: a.evEbit, pl: a.pl }];
  });
  console.log(`  ${candidates.length} candidatos após filtros (financeiras excluídas)\n`);

  // 5. Rankear por janela
  console.log("Rankeando candidatos...");
  const raw30d = rankWindow(candidates, priceToday, price30d, low52w);
  const raw60d = rankWindow(candidates, priceToday, price60d, low52w);
  const raw90d = rankWindow(candidates, priceToday, price90d, low52w);

  const { top30d, top60d, top90d } = attachJanelas(raw30d, raw60d, raw90d);

  const consenso = [...top30d, ...top60d, ...top90d]
    .filter((e) => e.janelas >= 2)
    .map((e) => e.ticker);
  const uniqConsenso = [...new Set(consenso)];

  console.log(`  30d: ${top30d.length} candidatos`);
  console.log(`  60d: ${top60d.length} candidatos`);
  console.log(`  90d: ${top90d.length} candidatos`);
  console.log(`  Consenso (2+/3 janelas): ${uniqConsenso.join(", ") || "nenhum"}\n`);

  // 6. Exibir top-5 de cada janela + sinalizadores
  for (const [label, list] of [
    ["30d", top30d],
    ["60d", top60d],
    ["90d", top90d],
  ] as const) {
    console.log(`Top-5 janela ${label}:`);
    for (const e of list.slice(0, 5)) {
      const min52w =
        e.pctAboveMin52w !== null
          ? `+${(e.pctAboveMin52w * 100).toFixed(1)}% acima mín`
          : "mín52s=?";
      const janelasMark = e.janelas === 3 ? "★★★" : e.janelas === 2 ? "★★" : "★";
      console.log(
        `  ${e.rank}. ${e.ticker.padEnd(7)} qrel=${(e.quedaRelativa * 100).toFixed(1)}%  EV/EBIT=${e.evEbit.toFixed(2)}  ${min52w}  ${janelasMark}  score=${e.score}`,
      );
    }
    console.log("");
  }

  // 7. Verificar se algum candidato tem pctAboveMin52w ≤ NEAR_MIN52W_THRESHOLD
  const near52wList = [...top30d, ...top60d, ...top90d]
    .filter((e, i, arr) => arr.findIndex((x) => x.ticker === e.ticker) === i)
    .filter((e) => e.pctAboveMin52w !== null && e.pctAboveMin52w <= NEAR_MIN52W_THRESHOLD)
    .sort((a, b) => (a.pctAboveMin52w ?? 0) - (b.pctAboveMin52w ?? 0));

  if (near52wList.length > 0) {
    console.log(`Atenção — perto da mínima de 52 semanas (<= ${NEAR_MIN52W_THRESHOLD * 100}%):`);
    for (const e of near52wList) {
      console.log(
        `  ${e.ticker.padEnd(7)} +${((e.pctAboveMin52w ?? 0) * 100).toFixed(1)}% acima mín`,
      );
    }
    console.log("");
  }

  // 8. Gerar HTML
  gravarScanHtml({ dateToday, date30d, date60d, date90d, top30d, top60d, top90d }, SCAN_HTML);
  console.log(`HTML gerado em ${SCAN_HTML}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
