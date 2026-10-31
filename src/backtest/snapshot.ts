import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { sampleStandardDeviation } from "simple-statistics";
import { isFinanceira } from "../config.js";
import { loadDfp } from "../sources/cvm.js";
import type { RawStock } from "../types.js";
import { buildB3Maps, lookupTicker } from "./mapping.js";

/** Carrega data/setor_map.json → Map<ticker, setor> */
function loadSetorMap(): Map<string, string> {
  try {
    const raw = JSON.parse(readFileSync("data/setor_map.json", "utf-8")) as Record<string, string>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

const SETOR_MAP = loadSetorMap();

// Pregões em ~2 meses (para liquidezMedia)
const TRADING_DAYS_2M = 42;
// Pregões em 12 meses (para volatilidade)
const TRADING_DAYS_12M = 252;
const MIN_PRICES_VOL = 21;
// Momentum 12-1m
const MOM_DAYS_1M = 21;
const MOM_DAYS_13M = 273;

interface DayBar {
  date: string; // YYYYMMDD
  close: number; // R$
  volBRL: number; // volume R$ no dia
}

/**
 * Parseia COTAHIST em modo streaming, retornando apenas barras até simDate.
 * Extrai PREULT (pos 108-120) e VOLTOT (pos 188-201).
 * VOLTOT está em R$ × 100 na especificação B3.
 */
async function parseCotahistUpTo(
  filePath: string,
  simDate: string, // "YYYYMMDD"
): Promise<Map<string, DayBar[]>> {
  const result = new Map<string, DayBar[]>();

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "latin1" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (line.length < 202) continue;
    if (line.slice(0, 2) !== "01") continue;
    const codbdi = line.slice(10, 12);
    if (codbdi !== "02" && codbdi !== "14") continue; // 02=ação, 14=ETF (BOVA11)
    if (line.slice(24, 27) !== "010") continue;

    const date = line.slice(2, 10);
    if (date > simDate) continue; // look-ahead safe

    const ticker = line.slice(12, 24).trim();
    const preult = Number.parseInt(line.slice(108, 121), 10);
    const quatot = Number.parseInt(line.slice(152, 170), 10); // quantidade de ações negociadas

    if (!ticker || Number.isNaN(preult) || preult <= 0) continue;

    const close = preult / 100;
    // Volume proxy: QUATOT × close (evita ambiguidade de escala do VOLTOT)
    const volBRL = Number.isNaN(quatot) || quatot <= 0 ? 0 : quatot * close;

    let bars = result.get(ticker);
    if (bars === undefined) {
      bars = [];
      result.set(ticker, bars);
    }
    bars.push({ date, close, volBRL });
  }

  // Ordenar por data
  for (const bars of result.values()) {
    bars.sort((a, b) => a.date.localeCompare(b.date));
  }

  return result;
}

function mergeBarMaps(base: Map<string, DayBar[]>, extra: Map<string, DayBar[]>): void {
  for (const [ticker, bars] of extra) {
    const existing = base.get(ticker);
    if (existing === undefined) {
      base.set(ticker, bars);
    } else {
      existing.push(...bars);
    }
  }
  // Re-sort merged entries
  for (const bars of base.values()) {
    bars.sort((a, b) => a.date.localeCompare(b.date));
  }
}

function calcVol(closes: number[]): number | null {
  if (closes.length < MIN_PRICES_VOL + 1) return null;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    if (prev > 0 && curr > 0) logReturns.push(Math.log(curr / prev));
  }
  if (logReturns.length < MIN_PRICES_VOL) return null;
  return sampleStandardDeviation(logReturns) * Math.sqrt(TRADING_DAYS_12M);
}

/**
 * Constrói um snapshot de RawStock[] para a data de simulação especificada.
 *
 * Lógica look-ahead safe:
 *   - Fundamentals: DFP do ano fiscal anterior (dtRefer = ano-1, 31/12).
 *     Apenas empresas onde dtReceb < simDateISO (data de recebimento CVM).
 *   - Preços e volume: COTAHIST até simDate (inclusive).
 *
 * @param simDateISO  "AAAA-MM-DD"  ex: "2023-04-01"
 * @param cotahistDir Diretório com os TXTs do COTAHIST já extraídos
 * @param cacheDir    Diretório de cache (DFP + B3 maps)
 */
export interface SnapshotResult {
  rawAcoes: RawStock[];
  volMap: Map<string, number | null>; // ticker → volatilidade anualizada (12 meses antes de simDate)
}

export async function buildSnapshot(
  simDateISO: string, // "AAAA-MM-DD"
  cotahistDir: string,
  cacheDir: string,
): Promise<SnapshotResult> {
  const simDate = simDateISO.replace(/-/g, ""); // "YYYYMMDD"
  const simYear = Number.parseInt(simDateISO.slice(0, 4), 10);

  // --- 1. Fundamentals CVM DFP ---
  const dfpYear = simYear - 1; // exercício fiscal do ano anterior
  console.log(`  [snapshot] DFP ${dfpYear} (simDate=${simDateISO})`);
  const dfpMap = await loadDfp(dfpYear, cacheDir);

  // Filtrar look-ahead: apenas empresas com dtReceb < simDateISO
  const fundamentals = [...dfpMap.values()].filter((f) => f.dtReceb < simDateISO);
  console.log(
    `  [snapshot] ${fundamentals.length}/${dfpMap.size} empresas com DFP recebido antes de ${simDateISO}`,
  );

  // --- 2. B3 maps (CNPJ → código4) ---
  const b3Maps = await buildB3Maps(cacheDir);

  // --- 3. COTAHIST --- carregar anos necessários (ano anterior + simYear)
  const years = [simYear - 1, simYear];
  const barMap = new Map<string, DayBar[]>();

  for (const year of years) {
    // Arquivo TXT extraído pelo cotahist.ts: COTAHIST_A{year}.TXT
    const txtPath = join(cotahistDir, `COTAHIST_A${year}.TXT`);
    if (!existsSync(txtPath)) {
      console.warn(`  [snapshot] COTAHIST ${year} não encontrado em ${txtPath}, pulando`);
      continue;
    }
    console.log(`  [snapshot] Parseando COTAHIST ${year} até ${simDate}...`);
    const extra = await parseCotahistUpTo(txtPath, simDate);
    mergeBarMaps(barMap, extra);
  }

  // --- 4. Volatilidade por ticker (últimos 252 pregões no barMap) ---
  const volMap = new Map<string, number | null>();
  for (const [ticker, bars] of barMap) {
    const closes = bars.slice(-TRADING_DAYS_12M).map((b) => b.close);
    volMap.set(ticker, calcVol(closes));
  }

  // --- 5. Montar RawStock[] ---
  const result: RawStock[] = [];

  for (const fund of fundamentals) {
    const info = lookupTicker(fund.cnpj, fund.cdCvm, b3Maps);
    if (!info) continue; // empresa não listada na B3

    // Encontrar ticker ativo (preferir ON=3, PN=4, depois outros)
    const suffixes = ["3", "4", "11", "5", "6"];
    let ticker: string | null = null;
    let bars: DayBar[] | null = null;

    for (const suf of suffixes) {
      const t = `${info.codigo4}${suf}`;
      const b = barMap.get(t);
      if (b && b.length > 0) {
        ticker = t;
        bars = b;
        break;
      }
    }

    if (!ticker || !bars || bars.length === 0) continue;

    // Preço mais recente (último pregão ≤ simDate)
    const lastBar = bars[bars.length - 1] as DayBar;
    const price = lastBar.close;

    let qtAcoes = fund.qtAcoes;
    if (!qtAcoes || qtAcoes <= 0 || price <= 0) continue;

    // Alguns emissores CVM reportam QT_ACAO em milhares (escala MIL).
    // Detecta: se P/VP implícito < 0.05, o qtAcoes está em milhares → corrige.
    if (fund.patLiq && fund.patLiq > 0 && (price * qtAcoes) / fund.patLiq < 0.05) {
      qtAcoes = qtAcoes * 1000;
    }

    const marketCap = price * qtAcoes;

    // Ratios
    const pl = fund.lucroLiq && fund.lucroLiq > 0 ? marketCap / fund.lucroLiq : null;
    const pvp = fund.patLiq && fund.patLiq > 0 ? marketCap / fund.patLiq : null;
    const divLiq =
      fund.dividaCP !== null && fund.dividaLP !== null && fund.caixa !== null
        ? fund.dividaCP + fund.dividaLP - fund.caixa
        : null;
    const ev = divLiq !== null ? marketCap + divLiq : marketCap;
    const evEbit = fund.ebit && fund.ebit > 0 ? ev / fund.ebit : null;
    const roe =
      fund.patLiq && fund.patLiq > 0 && fund.lucroLiq !== null ? fund.lucroLiq / fund.patLiq : null;

    // pl12m proxy: lucro líquido positivo? (Fundamentus usa margem líq; aqui
    // usamos lucroLiq como proxy — null se negativo para consistência com filtro)
    const pl12m = fund.lucroLiq !== null ? fund.lucroLiq / qtAcoes : null;

    // liquidezMedia: volume médio diário (R$) nos últimos 42 pregões
    const recentBars = bars.slice(-TRADING_DAYS_2M);
    const liquidezMedia =
      recentBars.length > 0
        ? recentBars.reduce((s, b) => s + b.volBRL, 0) / recentBars.length
        : null;

    // mom12m: retorno de 13m atrás até 1m atrás (momentum 12-1m)
    const Nb = bars.length;
    const p1mBar = Nb > MOM_DAYS_1M ? bars[Nb - 1 - MOM_DAYS_1M] : undefined;
    const p13mBar = Nb > MOM_DAYS_13M ? bars[Nb - 1 - MOM_DAYS_13M] : undefined;
    const mom12m = p1mBar && p13mBar && p13mBar.close > 0 ? p1mBar.close / p13mBar.close - 1 : null;

    // Patrimônio líquido (em R$) — passado diretamente ao RawStock
    const patLiq = fund.patLiq;

    // Setor: buscar no setor_map.json; fallback para derivar do nome CVM
    const setor =
      SETOR_MAP.get(ticker) ??
      (isFinanceira(fund.denom.toLowerCase()) ? "Intermediários Financeiros" : "Outros");

    result.push({
      ticker,
      setor,
      liquidezMedia,
      pl,
      pvp,
      evEbit,
      pebit: null, // não disponível via CVM DFP
      dy: null,
      divLiqPatrim: null,
      pl12m,
      patLiq,
      roe,
      mom12m,
    });
  }

  const comVol = [...volMap.values()].filter((v) => v !== null).length;
  console.log(
    `  [snapshot] ${result.length} stocks | vol: ${comVol}/${volMap.size} tickers (${((comVol / Math.max(volMap.size, 1)) * 100).toFixed(0)}%)`,
  );
  return { rawAcoes: result, volMap };
}

/**
 * Retorna o último preço de fechamento ≤ simDateISO para cada ticker no COTAHIST.
 * Usado pelo engine para calcular retornos entre datas.
 */
export async function buildLastPriceMap(
  simDateISO: string, // "AAAA-MM-DD"
  cotahistDir: string,
): Promise<Map<string, number>> {
  const simDate = simDateISO.replace(/-/g, "");
  const simYear = Number.parseInt(simDateISO.slice(0, 4), 10);
  const years = [simYear - 1, simYear];
  const barMap = new Map<string, DayBar[]>();

  for (const year of years) {
    const txtPath = join(cotahistDir, `COTAHIST_A${year}.TXT`);
    if (!existsSync(txtPath)) continue;
    const extra = await parseCotahistUpTo(txtPath, simDate);
    mergeBarMaps(barMap, extra);
  }

  const priceMap = new Map<string, number>();
  for (const [ticker, bars] of barMap) {
    if (bars.length === 0) continue;
    const lastBar = bars[bars.length - 1] as DayBar;
    priceMap.set(ticker, lastBar.close);
  }
  return priceMap;
}

// ── buildScanPriceMaps ────────────────────────────────────────────────────────

export interface ScanPriceMaps {
  priceToday: Map<string, number>;
  price30d: Map<string, number>;
  price60d: Map<string, number>;
  price90d: Map<string, number>;
  low52w: Map<string, number>; // mínimo de fechamento nos últimos 252 pregões
  low52wDate: Map<string, string>; // data "YYYYMMDD" da mínima de 52 semanas
  mom12mMap: Map<string, number | null>; // momentum 12-1m por ticker
  volMap: Map<string, number>; // volatilidade anualizada (últimos 252 pregões)
}

/** Retorna último fechamento ≤ date para o ticker (bars ordenados asc). */
function lastCloseAtOrBefore(bars: DayBar[], date: string): number | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    if ((bars[i] as DayBar).date <= date) return (bars[i] as DayBar).close;
  }
  return null;
}

/**
 * Carrega COTAHIST uma única vez e extrai todos os price maps necessários
 * para o scan (hoje + 3 janelas de referência + mínima 52 semanas).
 */
export async function buildScanPriceMaps(
  dateToday: string, // "AAAA-MM-DD"
  date30d: string,
  date60d: string,
  date90d: string,
  cotahistDir: string,
): Promise<ScanPriceMaps> {
  const simDate = dateToday.replace(/-/g, "");
  const d30 = date30d.replace(/-/g, "");
  const d60 = date60d.replace(/-/g, "");
  const d90 = date90d.replace(/-/g, "");

  const simYear = Number.parseInt(dateToday.slice(0, 4), 10);
  const years = [simYear - 1, simYear];
  const barMap = new Map<string, DayBar[]>();

  for (const year of years) {
    const txtPath = join(cotahistDir, `COTAHIST_A${year}.TXT`);
    if (!existsSync(txtPath)) continue;
    console.log(`  [scan] Parseando COTAHIST ${year}...`);
    const extra = await parseCotahistUpTo(txtPath, simDate);
    mergeBarMaps(barMap, extra);
  }

  const priceToday = new Map<string, number>();
  const price30d = new Map<string, number>();
  const price60d = new Map<string, number>();
  const price90d = new Map<string, number>();
  const low52w = new Map<string, number>();
  const low52wDate = new Map<string, string>();
  const mom12mMap = new Map<string, number | null>();
  const volMap = new Map<string, number>();

  for (const [ticker, bars] of barMap) {
    if (bars.length === 0) continue;

    priceToday.set(ticker, (bars[bars.length - 1] as DayBar).close);

    const p30 = lastCloseAtOrBefore(bars, d30);
    if (p30 !== null) price30d.set(ticker, p30);

    const p60 = lastCloseAtOrBefore(bars, d60);
    if (p60 !== null) price60d.set(ticker, p60);

    const p90 = lastCloseAtOrBefore(bars, d90);
    if (p90 !== null) price90d.set(ticker, p90);

    const recent = bars.slice(-TRADING_DAYS_12M);
    let lowPrice = Number.POSITIVE_INFINITY;
    let lowDateStr = "";
    for (const b of recent) {
      if (b.close < lowPrice) {
        lowPrice = b.close;
        lowDateStr = b.date;
      }
    }
    if (Number.isFinite(lowPrice) && lowDateStr) {
      low52w.set(ticker, lowPrice);
      low52wDate.set(ticker, lowDateStr);
    }

    // Momentum 12-1m (mesmo cálculo de buildSnapshot)
    const Nb = bars.length;
    const p1mBar = Nb > MOM_DAYS_1M ? bars[Nb - 1 - MOM_DAYS_1M] : undefined;
    const p13mBar = Nb > MOM_DAYS_13M ? bars[Nb - 1 - MOM_DAYS_13M] : undefined;
    const mom12m = p1mBar && p13mBar && p13mBar.close > 0 ? p1mBar.close / p13mBar.close - 1 : null;
    mom12mMap.set(ticker, mom12m);

    // Volatilidade anualizada (últimos 252 pregões)
    const vol = calcVol(bars.slice(-TRADING_DAYS_12M).map((b) => b.close));
    if (vol !== null) volMap.set(ticker, vol);
  }

  return { priceToday, price30d, price60d, price90d, low52w, low52wDate, mom12mMap, volMap };
}
