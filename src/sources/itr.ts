import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { retry } from "../utils/retry.js";

const CVM_ITR_BASE = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/ITR/DADOS";

// Conta do plano de contas CVM — DRE
const CD_LUCRO_LIQ = "3.11";
// Contas de balanço para dívida líquida
const CD_DIVIDA_CP = "2.01.04";
const CD_DIVIDA_LP = "2.02.01";
const CD_CAIXA = "1.01.01";

export interface ItrTrimestre {
  cnpj: string; // 14 dígitos
  dtFimExerc: string; // "YYYY-MM-DD" do trimestre mais recente
  dtReceb: string; // data de recebimento na CVM
  lucroLiqTri: number | null; // lucro líquido do último trimestre isolado
  lucroLiqTriAA: number | null; // lucro líquido do mesmo trimestre no ano anterior
  dividaLiq: number | null; // dívida líquida ao fim do último trimestre
  dividaLiqPrev: number | null; // dívida líquida ao fim do trimestre anterior
}

type Row = Record<string, string | undefined>;

function parseCsv(content: string): Row[] {
  const lines = content.split("\n");
  if (lines.length < 2) return [];
  const headers = (lines[0] ?? "").trim().split(";");
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    const vals = line.split(";");
    const row: Row = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      if (key !== undefined) row[key] = vals[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function col(row: Row, key: string): string {
  return row[key] ?? "";
}

function toNum(s: string, fator: number): number | null {
  if (!s || s === "-") return null;
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return n * fator;
}

function escalaFator(row: Row): number {
  return col(row, "ESCALA_MOEDA") === "MIL" ? 1000 : 1;
}

function entryStr(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  return entry.getData().toString("latin1");
}

/** Trimestre anterior no mesmo ano (ITR cobre Q1–Q3; Q4 está no DFP). */
function prevQuarter(dtRefer: string): string | null {
  const year = dtRefer.slice(0, 4);
  const mm = dtRefer.slice(5, 7);
  if (mm === "06") return `${year}-03-31`;
  if (mm === "09") return `${year}-06-30`;
  return null; // Q1: sem trimestre anterior no mesmo ZIP
}

/**
 * Baixa e parseia os ITRs trimestrais (Q1–Q3) do ano especificado.
 * Retorna o trimestre mais recente disponível por empresa.
 *
 * O DRE no ITR é YTD acumulado → lucro trimestral = YTD[Q] − YTD[Q−1].
 * O PENÚLTIMO no DRE fornece o comparativo do mesmo período do ano anterior.
 *
 * Resultado cacheado em {cacheDir}/itr_{ano}.json.
 */
export async function loadItr(ano: number, cacheDir: string): Promise<Map<string, ItrTrimestre>> {
  mkdirSync(cacheDir, { recursive: true });

  const jsonPath = join(cacheDir, `itr_${ano}.json`);
  if (existsSync(jsonPath)) {
    console.log(`  ITR ${ano}: cache`);
    const arr = JSON.parse(readFileSync(jsonPath, "utf-8")) as ItrTrimestre[];
    return new Map(arr.map((t) => [t.cnpj, t]));
  }

  // 1. Download ZIP
  const zipPath = join(cacheDir, `itr_${ano}.zip`);
  if (!existsSync(zipPath)) {
    const url = `${CVM_ITR_BASE}/itr_cia_aberta_${ano}.zip`;
    console.log(`  Baixando ITR ${ano}...`);
    const buf = await retry(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ITR ${ano} HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    writeFileSync(zipPath, buf);
    console.log(`  Salvo ${zipPath} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  // 2. Parse
  console.log(`  Parseando ITR ${ano}...`);
  const zip = new AdmZip(zipPath);
  const pfx = "itr_cia_aberta";

  // --- Master: manter versão mais recente por (CNPJ, DT_REFER) ---
  // Apenas trimestres Q1/Q2/Q3 (-03-31, -06-30, -09-30)
  type QKey = string; // `${cnpj}__${dtRefer}`
  type QVal = { dtRefer: string; dtReceb: string; versao: number };
  const masterMap = new Map<QKey, QVal>();

  const masterContent = entryStr(zip, `${pfx}_${ano}.csv`);
  if (!masterContent) throw new Error(`ITR ${ano}: master CSV não encontrado no ZIP`);

  for (const row of parseCsv(masterContent)) {
    const dtRefer = col(row, "DT_REFER");
    const mm = dtRefer.slice(5, 7);
    if (mm !== "03" && mm !== "06" && mm !== "09") continue; // excluir 12-31 (DFP)
    const cnpj = col(row, "CNPJ_CIA");
    if (!cnpj) continue;
    const versao = Number(col(row, "VERSAO")) || 0;
    const key: QKey = `${cnpj}__${dtRefer}`;
    const existing = masterMap.get(key);
    if (!existing || versao > existing.versao) {
      masterMap.set(key, { dtRefer, dtReceb: col(row, "DT_RECEB"), versao });
    }
  }

  // --- Trimestre mais recente por empresa ---
  const latestByCompany = new Map<string, string>(); // cnpj → dtRefer
  for (const [key, val] of masterMap) {
    const cnpj = key.split("__")[0] as string;
    const existing = latestByCompany.get(cnpj);
    if (!existing || val.dtRefer > existing) latestByCompany.set(cnpj, val.dtRefer);
  }

  // --- YTD lucroLiq do DRE (ÚLTIMO e PENÚLTIMO) por (cnpj, dtRefer) ---
  // Key: `${cnpj}__${dtRefer}__${ordemExerc}` → valor YTD
  // _con_ processado primeiro; _ind_ usado como fallback (has-guard abaixo)
  const dreYtd = new Map<string, number | null>();

  function loadDre(csvName: string): void {
    const content = entryStr(zip, csvName);
    if (!content) return;
    for (const row of parseCsv(content)) {
      const ordem = col(row, "ORDEM_EXERC");
      if (ordem !== "ÚLTIMO" && ordem !== "PENÚLTIMO") continue;
      if (col(row, "CD_CONTA") !== CD_LUCRO_LIQ) continue;
      const cnpj = col(row, "CNPJ_CIA");
      const dtRefer = col(row, "DT_REFER");
      const master = masterMap.get(`${cnpj}__${dtRefer}`);
      if (!master) continue;
      if ((Number(col(row, "VERSAO")) || 0) !== master.versao) continue;
      const dreKey = `${cnpj}__${dtRefer}__${ordem}`;
      if (!dreYtd.has(dreKey)) {
        dreYtd.set(dreKey, toNum(col(row, "VL_CONTA"), escalaFator(row)));
      }
    }
  }

  loadDre(`${pfx}_DRE_con_${ano}.csv`);
  loadDre(`${pfx}_DRE_ind_${ano}.csv`); // fallback: ignora se con já tem a chave

  // --- Balanço: dividaCP, dividaLP, caixa por (cnpj, dtRefer) ---
  type BsVal = { dividaCP: number | null; dividaLP: number | null; caixa: number | null };
  const bsMap = new Map<string, BsVal>();

  function ensureBs(key: string): BsVal {
    let bs = bsMap.get(key);
    if (!bs) {
      bs = { dividaCP: null, dividaLP: null, caixa: null };
      bsMap.set(key, bs);
    }
    return bs;
  }

  function loadBpp(csvName: string): void {
    const content = entryStr(zip, csvName);
    if (!content) return;
    for (const row of parseCsv(content)) {
      if (col(row, "ORDEM_EXERC") !== "ÚLTIMO") continue;
      const cd = col(row, "CD_CONTA");
      if (cd !== CD_DIVIDA_CP && cd !== CD_DIVIDA_LP) continue;
      const cnpj = col(row, "CNPJ_CIA");
      const dtRefer = col(row, "DT_REFER");
      const master = masterMap.get(`${cnpj}__${dtRefer}`);
      if (!master) continue;
      if ((Number(col(row, "VERSAO")) || 0) !== master.versao) continue;
      const bs = ensureBs(`${cnpj}__${dtRefer}`);
      const val = toNum(col(row, "VL_CONTA"), escalaFator(row));
      if (cd === CD_DIVIDA_CP && bs.dividaCP === null) bs.dividaCP = val;
      else if (cd === CD_DIVIDA_LP && bs.dividaLP === null) bs.dividaLP = val;
    }
  }

  function loadBpa(csvName: string): void {
    const content = entryStr(zip, csvName);
    if (!content) return;
    for (const row of parseCsv(content)) {
      if (col(row, "ORDEM_EXERC") !== "ÚLTIMO") continue;
      if (col(row, "CD_CONTA") !== CD_CAIXA) continue;
      const cnpj = col(row, "CNPJ_CIA");
      const dtRefer = col(row, "DT_REFER");
      const master = masterMap.get(`${cnpj}__${dtRefer}`);
      if (!master) continue;
      if ((Number(col(row, "VERSAO")) || 0) !== master.versao) continue;
      const bs = ensureBs(`${cnpj}__${dtRefer}`);
      if (bs.caixa === null) bs.caixa = toNum(col(row, "VL_CONTA"), escalaFator(row));
    }
  }

  loadBpp(`${pfx}_BPP_con_${ano}.csv`);
  loadBpa(`${pfx}_BPA_con_${ano}.csv`);
  loadBpp(`${pfx}_BPP_ind_${ano}.csv`); // fallback: null-guard impede sobrescrever _con_
  loadBpa(`${pfx}_BPA_ind_${ano}.csv`);

  // --- Calcular dívida líquida a partir do balanço ---
  function calcDividaLiq(bs: BsVal | undefined): number | null {
    if (!bs) return null;
    if (bs.dividaCP === null && bs.dividaLP === null) return null;
    return (bs.dividaCP ?? 0) + (bs.dividaLP ?? 0) - (bs.caixa ?? 0);
  }

  // --- Montar resultado ---
  const result: ItrTrimestre[] = [];

  for (const [cnpj, latestDt] of latestByCompany) {
    const master = masterMap.get(`${cnpj}__${latestDt}`);
    if (!master) continue;

    const prevDt = prevQuarter(latestDt);

    // YTD lucroLiq (ÚLTIMO = período atual; PENÚLTIMO = mesmo período ano anterior)
    const ytdUlt = dreYtd.get(`${cnpj}__${latestDt}__ÚLTIMO`) ?? null;
    const ytdPenu = dreYtd.get(`${cnpj}__${latestDt}__PENÚLTIMO`) ?? null;
    const ytdPrevUlt = prevDt ? (dreYtd.get(`${cnpj}__${prevDt}__ÚLTIMO`) ?? null) : null;
    const ytdPrevPenu = prevDt ? (dreYtd.get(`${cnpj}__${prevDt}__PENÚLTIMO`) ?? null) : null;

    // Lucro trimestral isolado = YTD atual − YTD trimestre anterior
    // Para Q1 (sem prevDt), o YTD já é o valor trimestral
    const lucroLiqTri =
      ytdUlt !== null ? (prevDt && ytdPrevUlt !== null ? ytdUlt - ytdPrevUlt : ytdUlt) : null;

    const lucroLiqTriAA =
      ytdPenu !== null ? (prevDt && ytdPrevPenu !== null ? ytdPenu - ytdPrevPenu : ytdPenu) : null;

    result.push({
      cnpj,
      dtFimExerc: latestDt,
      dtReceb: master.dtReceb,
      lucroLiqTri,
      lucroLiqTriAA,
      dividaLiq: calcDividaLiq(bsMap.get(`${cnpj}__${latestDt}`)),
      dividaLiqPrev: calcDividaLiq(prevDt ? bsMap.get(`${cnpj}__${prevDt}`) : undefined),
    });
  }

  writeFileSync(jsonPath, JSON.stringify(result), "utf-8");
  console.log(`  ITR ${ano}: ${result.length} empresas`);

  return new Map(result.map((t) => [t.cnpj, t]));
}
