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
const NEAR_MIN52W_THRESHOLD = 0.15;
const CORP_EVENT_THRESHOLD = 2.0; // ↑ Mín52s > 200% → excluir como evento corporativo

// ── Agrupamento de setores em fatores ─────────────────────────────────────────
// Usado para o limite de 2 por grupo no consenso.

const FATOR_MAP: Record<string, string> = {
  "Construção Civil": "Imobiliário",
  "Exploração de Imóveis": "Imobiliário",
  Incorporações: "Imobiliário",
  Comércio: "Varejo",
  "Comércio e Distribuição": "Varejo",
  Varejo: "Varejo",
  "Petróleo, Gás e Biocombustíveis": "Energia/Commodities",
  "Energia Elétrica": "Energia/Commodities",
  Mineração: "Energia/Commodities",
  "Siderurgia e Metalurgia": "Energia/Commodities",
  Agropecuária: "Alimentos",
  "Alimentos Processados": "Alimentos",
  Bebidas: "Alimentos",
  Frigoríficos: "Alimentos",
  "Locação de Máq. e Equip.": "Locação/Infraestrutura",
  Transporte: "Locação/Infraestrutura",
};

function fatorSetor(setor: string): string {
  return FATOR_MAP[setor] ?? setor;
}

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

/** Converte "YYYYMMDD" → "DD/MM/YYYY" */
function fmtDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(0, 4)}`;
}

// ── Candidatos ───────────────────────────────────────────────────────────────

interface Candidate extends RawStock {
  liquidezMedia: number;
  evEbit: number;
  pl: number;
}

// ── Dedupe por raiz do ticker ─────────────────────────────────────────────────

function dedupeByRoot(candidates: Candidate[]): Candidate[] {
  const byRoot = new Map<string, Candidate>();
  for (const c of candidates) {
    const root = c.ticker.slice(0, 4);
    const existing = byRoot.get(root);
    if (!existing || (c.liquidezMedia ?? 0) > (existing.liquidezMedia ?? 0)) {
      byRoot.set(root, c);
    }
  }
  return [...byRoot.values()];
}

// ── Knife score (por ticker, calculado uma única vez) ─────────────────────────
//
// Componentes (0–5 pts, cada um vale 1):
//   (a) Momentum 12m no decil inferior dos candidatos
//   (b) Cotação ≤ 5% acima da mínima de 52 semanas
//   (c) juros↑: conversao = P/EBIT ÷ P/L < 0,40 E dívida líquida > 0
//   (d) Lucro não-recorrente: D.Y. > 20% OU P/L > 50
//   (e) Queda forte: retorno no pior pregão nos últimos 30 dias > |25%|
//       (não disponível no COTAHIST scan; substituído por queda vs BOVA > 20%)
//
// Escala: 0–1 🟢 · 2–3 🟡 · 4–5 🔴

export interface KnifInfo {
  score: number;
  // sinais individuais para display
  momBaixo: boolean; // (a)
  nearMin52w: boolean; // (b)
  jurosAlerta: boolean; // (c)
  lucroNaoRecorrente: boolean; // (d)
  // campos para auditoria
  conversao: number | null; // P/EBIT / P/L
}

function buildKnifMap(
  candidates: Candidate[],
  priceToday: Map<string, number>,
  low52w: Map<string, number>,
  mom12mMap: Map<string, number | null>,
): Map<string, KnifInfo> {
  // Limiar do decil inferior do momentum (entre os candidatos com dados)
  const moms = candidates
    .map((c) => mom12mMap.get(c.ticker) ?? null)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const decileIdx = Math.max(0, Math.floor(moms.length * 0.1) - 1);
  const momThreshold = moms[decileIdx] ?? -Number.POSITIVE_INFINITY;

  const knifMap = new Map<string, KnifInfo>();

  for (const c of candidates) {
    const p1 = priceToday.get(c.ticker);
    const low = low52w.get(c.ticker);
    const pctAboveMin52w = p1 && low && low > 0 ? p1 / low - 1 : null;

    const mom12m = mom12mMap.get(c.ticker) ?? null;

    // (a) Momentum no decil inferior
    const momBaixo = mom12m !== null && mom12m <= momThreshold;

    // (b) Na mínima de 52 semanas (≤ 5%)
    const nearMin52w = pctAboveMin52w !== null && pctAboveMin52w <= 0.05;

    // (c) juros: conversao = P/EBIT / P/L < 0,40 E dívida líquida > 0
    const conversao = c.pebit !== null && c.pebit > 0 && c.pl > 0 ? c.pebit / c.pl : null;
    const jurosAlerta = conversao !== null && conversao < 0.4 && (c.divLiqPatrim ?? 0) > 0;

    // (d) Lucro não-recorrente: D.Y. > 20% OU P/L > 50
    const lucroNaoRecorrente = (c.dy !== null && c.dy > 0.2) || c.pl > 50;

    const score = [momBaixo, nearMin52w, jurosAlerta, lucroNaoRecorrente].filter(Boolean).length;

    knifMap.set(c.ticker, {
      score,
      momBaixo,
      nearMin52w,
      jurosAlerta,
      lucroNaoRecorrente,
      conversao,
    });
  }

  return knifMap;
}

// ── Ranking por janela ────────────────────────────────────────────────────────

function rankWindow(
  candidates: Candidate[],
  knifMap: Map<string, KnifInfo>,
  priceToday: Map<string, number>,
  priceRef: Map<string, number>,
  low52w: Map<string, number>,
  low52wDate: Map<string, string>,
): Omit<ScanEntry, "janelas">[] {
  const bovaToday = priceToday.get("BOVA11");
  const bovaRef = priceRef.get("BOVA11");
  if (!bovaToday || !bovaRef || bovaRef <= 0) return [];

  const retornoBovaPeriod = bovaToday / bovaRef - 1;

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
    const lowDateRaw = low52wDate.get(c.ticker);
    const low52wDateFmt = lowDateRaw ? fmtDate(lowDateRaw) : null;
    const low52wPrice = low ?? null;

    const knif = knifMap.get(c.ticker) ?? {
      score: 0,
      momBaixo: false,
      nearMin52w: false,
      jurosAlerta: false,
      lucroNaoRecorrente: false,
      conversao: null,
    };

    items.push({
      rank: 0,
      ticker: c.ticker,
      setor: c.setor,
      fator: fatorSetor(c.setor),
      evEbit: c.evEbit,
      pl: c.pl,
      pvp: c.pvp,
      retornoStock,
      retornoBova: retornoBovaPeriod,
      quedaRelativa,
      pctAboveMin52w,
      low52wDate: low52wDateFmt,
      low52wPrice,
      conversao: knif.conversao,
      jurosAlerta: knif.jurosAlerta,
      knifScore: knif.score,
      score: 0,
    });
  }

  if (items.length === 0) return [];

  const byQueda = [...items].sort((a, b) => a.quedaRelativa - b.quedaRelativa);
  const rankQueda = new Map(byQueda.map((x, i) => [x.ticker, i + 1]));

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

  // 2. Carregar price maps + mom12m (pass único do COTAHIST)
  console.log("Carregando price maps (pass único do COTAHIST)...");
  const { priceToday, price30d, price60d, price90d, low52w, low52wDate, mom12mMap } =
    await buildScanPriceMaps(dateToday, date30d, date60d, date90d, CACHE_DIR);
  console.log(
    `  tickers: hoje=${priceToday.size}  -30d=${price30d.size}  -60d=${price60d.size}  -90d=${price90d.size}  low52w=${low52w.size}\n`,
  );

  // 3. Coletar fundamentals
  console.log("Coletando fundamentals do Fundamentus...");
  const rawAcoesBase = await fetchFundamentus();
  console.log(`  ${rawAcoesBase.length} tickers coletados`);

  let setorMap: Record<string, string> = {};
  try {
    setorMap = JSON.parse(readFileSync("data/setor_map.json", "utf-8")) as Record<string, string>;
  } catch {
    /* sem mapa */
  }
  const rawAcoes = rawAcoesBase.map((a) =>
    a.setor === "Outros" && setorMap[a.ticker] ? { ...a, setor: setorMap[a.ticker] as string } : a,
  );

  // 4. Filtrar candidatos — excluir financeiras
  const rawCandidates: Candidate[] = rawAcoes.flatMap((a) => {
    if (isFinanceira(a.setor)) return [];
    if ((a.liquidezMedia ?? 0) < LIQUIDEZ_MIN) return [];
    if (a.evEbit === null || a.evEbit <= 0) return [];
    if (a.pl === null || a.pl <= 0) return [];
    return [{ ...a, liquidezMedia: a.liquidezMedia as number, evEbit: a.evEbit, pl: a.pl }];
  });

  // 5. Dedupe por raiz — manter o mais líquido
  const candidates = dedupeByRoot(rawCandidates);
  console.log(
    `  ${rawCandidates.length} candidatos → ${candidates.length} após dedupe (financeiras excluídas)\n`,
  );

  // 6. Detectar eventos corporativos (↑ Mín52s > 200%)
  const corporateEvents: Array<{ ticker: string; setor: string; pctAboveMin52w: number }> = [];
  const cleanCandidates = candidates.filter((c) => {
    const p1 = priceToday.get(c.ticker);
    const low = low52w.get(c.ticker);
    if (p1 && low && low > 0) {
      const ratio = p1 / low - 1;
      if (ratio > CORP_EVENT_THRESHOLD) {
        corporateEvents.push({ ticker: c.ticker, setor: c.setor, pctAboveMin52w: ratio });
        return false;
      }
    }
    return true;
  });
  if (corporateEvents.length > 0) {
    console.log(
      `  ⚠  Eventos corporativos detectados (excluídos): ${corporateEvents.map((e) => e.ticker).join(", ")}`,
    );
  }

  // 7. Calcular knife score UMA VEZ por ticker (independente da janela)
  const knifMap = buildKnifMap(cleanCandidates, priceToday, low52w, mom12mMap);

  // 8. Rankear por janela (knife score reutilizado de knifMap)
  console.log("Rankeando candidatos...");
  const raw30d = rankWindow(cleanCandidates, knifMap, priceToday, price30d, low52w, low52wDate);
  const raw60d = rankWindow(cleanCandidates, knifMap, priceToday, price60d, low52w, low52wDate);
  const raw90d = rankWindow(cleanCandidates, knifMap, priceToday, price90d, low52w, low52wDate);

  const { top30d, top60d, top90d } = attachJanelas(raw30d, raw60d, raw90d);

  const consenso = [...top30d, ...top60d, ...top90d]
    .filter((e) => e.janelas >= 2)
    .map((e) => e.ticker);
  const uniqConsenso = [...new Set(consenso)];

  console.log(`  30d: ${top30d.length} candidatos`);
  console.log(`  60d: ${top60d.length} candidatos`);
  console.log(`  90d: ${top90d.length} candidatos`);
  console.log(`  Consenso (2+/3 janelas): ${uniqConsenso.join(", ") || "nenhum"}\n`);

  // 9. Verificar consistência do knife score (teste de sanidade)
  const allEntries = [...top30d, ...top60d, ...top90d];
  const byTicker = new Map<string, number[]>();
  for (const e of allEntries) {
    const arr = byTicker.get(e.ticker) ?? [];
    arr.push(e.knifScore);
    byTicker.set(e.ticker, arr);
  }
  for (const [ticker, scores] of byTicker) {
    if (new Set(scores).size > 1) {
      console.warn(`  ⚠  knife score inconsistente para ${ticker}: ${scores.join(", ")}`);
    }
  }

  // 10. Exibir top-5 de cada janela
  for (const [label, list] of [
    ["30d", top30d],
    ["60d", top60d],
    ["90d", top90d],
  ] as const) {
    console.log(`Top-5 janela ${label}:`);
    for (const e of list.slice(0, 5)) {
      const min52w =
        e.pctAboveMin52w !== null
          ? `+${(e.pctAboveMin52w * 100).toFixed(1)}% (${e.low52wDate ?? "?"} R$${e.low52wPrice?.toFixed(2) ?? "?"})`
          : "mín52s=?";
      const janelasMark = e.janelas === 3 ? "★★★" : e.janelas === 2 ? "★★" : "★";
      const convStr = e.conversao !== null ? `  conv=${e.conversao.toFixed(2)}` : "";
      console.log(
        `  ${e.rank}. ${e.ticker.padEnd(7)} qrel=${(e.quedaRelativa * 100).toFixed(1)}%  EV/EBIT=${e.evEbit.toFixed(2)}  ${min52w}  ${janelasMark}  risco=${e.knifScore}${convStr}`,
      );
    }
    console.log("");
  }

  // 11. Listar candidatos perto da mínima de 52 semanas
  const near52wList = [...top30d, ...top60d, ...top90d]
    .filter((e, i, arr) => arr.findIndex((x) => x.ticker === e.ticker) === i)
    .filter((e) => e.pctAboveMin52w !== null && e.pctAboveMin52w <= NEAR_MIN52W_THRESHOLD)
    .sort((a, b) => (a.pctAboveMin52w ?? 0) - (b.pctAboveMin52w ?? 0));

  if (near52wList.length > 0) {
    console.log(`Atenção — perto da mínima de 52 semanas (<= ${NEAR_MIN52W_THRESHOLD * 100}%):`);
    for (const e of near52wList) {
      console.log(
        `  ${e.ticker.padEnd(7)} +${((e.pctAboveMin52w ?? 0) * 100).toFixed(1)}% (${e.low52wDate ?? "?"} R$${e.low52wPrice?.toFixed(2) ?? "?"})`,
      );
    }
    console.log("");
  }

  // 12. Gerar HTML
  gravarScanHtml(
    { dateToday, date30d, date60d, date90d, top30d, top60d, top90d, corporateEvents },
    SCAN_HTML,
  );
  console.log(`HTML gerado em ${SCAN_HTML}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
