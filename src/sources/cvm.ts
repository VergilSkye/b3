import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { retry } from "../utils/retry.js";

const CVM_DFP_BASE = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS";

// Contas do plano de contas CVM que nos interessam
const CONTAS_DRE = { ebit: "3.05", lucroLiq: "3.11" };
// patLiqIfrs: bancos/seguradoras IFRS usam 2.07 em vez de 2.03 para PL
const CONTAS_BPP = { patLiq: "2.03", patLiqIfrs: "2.07", dividaCP: "2.01.04", dividaLP: "2.02.01" };
const CONTAS_BPA = { caixa: "1.01.01" };

export interface FundamentoCVM {
  cnpj: string; // "33.000.167/0001-01"
  cdCvm: string; // código CVM numérico, sem zeros à esquerda (ex: "9512")
  denom: string; // "PETROLEO BRASILEIRO S.A. PETROBRAS"
  dtRefer: string; // "AAAA-12-31" — fim do exercício
  dtReceb: string; // data de recebimento CVM (look-ahead bias)
  ebit: number | null; // R$
  lucroLiq: number | null; // R$
  patLiq: number | null; // R$
  caixa: number | null; // R$
  dividaCP: number | null; // R$ — curto prazo
  dividaLP: number | null; // R$ — longo prazo
  qtAcoes: number | null; // ações em circulação (total − tesouraria)
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

function entryStr(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`CVM DFP ZIP: entrada '${name}' não encontrada`);
  return entry.getData().toString("latin1");
}

/**
 * Baixa e parseia o DFP anual de um ano específico.
 * Filtra apenas empresas com exercício encerrado em 31/12 (maioria das listadas).
 * Resultado cacheado em {cacheDir}/dfp_{ano}.json.
 *
 * Retorna Map<cnpj, FundamentoCVM>.
 */
export async function loadDfp(ano: number, cacheDir: string): Promise<Map<string, FundamentoCVM>> {
  mkdirSync(cacheDir, { recursive: true });

  const jsonPath = join(cacheDir, `dfp_${ano}.json`);
  if (existsSync(jsonPath)) {
    console.log(`  DFP ${ano}: cache`);
    const arr = JSON.parse(readFileSync(jsonPath, "utf-8")) as FundamentoCVM[];
    return new Map(arr.map((f) => [f.cnpj, f]));
  }

  // 1. Download ZIP
  const zipPath = join(cacheDir, `dfp_${ano}.zip`);
  if (!existsSync(zipPath)) {
    const url = `${CVM_DFP_BASE}/dfp_cia_aberta_${ano}.zip`;
    console.log(`  Baixando DFP ${ano}...`);
    const buf = await retry(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`DFP ${ano} HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    writeFileSync(zipPath, buf);
    const mb = (buf.length / 1024 / 1024).toFixed(1);
    console.log(`  Salvo ${zipPath} (${mb} MB)`);
  }

  // 2. Parse
  console.log(`  Parseando DFP ${ano}...`);
  const zip = new AdmZip(zipPath);
  const p = "dfp_cia_aberta"; // prefixo dos arquivos dentro do ZIP

  // --- Master: CNPJ → (dtRefer, dtReceb, versao) ---
  // Filtrar apenas exercícios encerrados em 31/12
  const masterRows = parseCsv(entryStr(zip, `${p}_${ano}.csv`));
  type MasterEntry = {
    dtRefer: string;
    dtReceb: string;
    denom: string;
    cdCvm: string;
    versao: number;
  };
  const masterMap = new Map<string, MasterEntry>(); // key = cnpj

  for (const row of masterRows) {
    if (!col(row, "DT_REFER").endsWith("-12-31")) continue;
    const cnpj = col(row, "CNPJ_CIA");
    if (!cnpj) continue;
    const versao = Number(col(row, "VERSAO")) || 0;
    const existing = masterMap.get(cnpj);
    if (!existing || versao > existing.versao) {
      masterMap.set(cnpj, {
        dtRefer: col(row, "DT_REFER"),
        dtReceb: col(row, "DT_RECEB"),
        denom: col(row, "DENOM_CIA"),
        cdCvm: String(Number(col(row, "CD_CVM")) || 0), // strip leading zeros
        versao,
      });
    }
  }

  // --- Helper: extrai uma conta por empresa ---
  function extrairConta(
    csvName: string,
    codigos: Record<string, string>,
  ): Map<string, Record<string, number | null>> {
    const rows = parseCsv(entryStr(zip, csvName));
    const result = new Map<string, Record<string, number | null>>();

    for (const row of rows) {
      // Apenas o exercício corrente (não o comparativo do ano anterior)
      if (col(row, "ORDEM_EXERC") !== "ÚLTIMO") continue;
      const cnpj = col(row, "CNPJ_CIA");
      const master = masterMap.get(cnpj);
      if (!master) continue;
      // Apenas a versão mais recente do DFP
      if ((Number(col(row, "VERSAO")) || 0) !== master.versao) continue;
      // Apenas DT_REFER do master
      if (col(row, "DT_REFER") !== master.dtRefer) continue;

      const cd = col(row, "CD_CONTA");
      const campo = Object.entries(codigos).find(([, v]) => v === cd)?.[0];
      if (!campo) continue;

      const fator = escalaFator(row);
      const val = toNum(col(row, "VL_CONTA"), fator);
      if (!result.has(cnpj)) result.set(cnpj, {});
      // biome-ignore lint/style/noNonNullAssertion: acabou de ser criado
      result.get(cnpj)![campo] = val;
    }
    return result;
  }

  // Usar demonstrações consolidadas (_con) para capturar caixa e dívida do grupo completo.
  // Fallback para _ind quando _con não existe (empresas sem subsidiárias).
  const dreData = extrairConta(`${p}_DRE_con_${ano}.csv`, CONTAS_DRE);
  const bppData = extrairConta(`${p}_BPP_con_${ano}.csv`, CONTAS_BPP);
  const bpaData = extrairConta(`${p}_BPA_con_${ano}.csv`, CONTAS_BPA);

  // Fallback _ind para empresas sem demonstração consolidada
  const dreInd = extrairConta(`${p}_DRE_ind_${ano}.csv`, CONTAS_DRE);
  const bppInd = extrairConta(`${p}_BPP_ind_${ano}.csv`, CONTAS_BPP);
  const bpaInd = extrairConta(`${p}_BPA_ind_${ano}.csv`, CONTAS_BPA);
  for (const [cnpj, vals] of dreInd) {
    if (!dreData.has(cnpj)) dreData.set(cnpj, vals);
  }
  for (const [cnpj, vals] of bppInd) {
    if (!bppData.has(cnpj)) bppData.set(cnpj, vals);
  }
  for (const [cnpj, vals] of bpaInd) {
    if (!bpaData.has(cnpj)) bpaData.set(cnpj, vals);
  }

  // --- Composição do capital: número de ações ---
  const capitalRows = parseCsv(entryStr(zip, `${p}_composicao_capital_${ano}.csv`));
  const sharesMap = new Map<string, number>(); // cnpj → qtAcoes

  for (const row of capitalRows) {
    const cnpj = col(row, "CNPJ_CIA");
    if (!masterMap.has(cnpj)) continue;
    const total = Number(col(row, "QT_ACAO_TOTAL_CAP_INTEGR")) || 0;
    const tesouraria = Number(col(row, "QT_ACAO_TOTAL_TESOURO")) || 0;
    const float = total - tesouraria;
    if (float > 0) sharesMap.set(cnpj, float);
  }

  // --- Montar resultado ---
  const result: FundamentoCVM[] = [];
  for (const [cnpj, master] of masterMap) {
    const dre = dreData.get(cnpj) ?? {};
    const bpp = bppData.get(cnpj) ?? {};
    const bpa = bpaData.get(cnpj) ?? {};

    result.push({
      cnpj,
      cdCvm: master.cdCvm,
      denom: master.denom,
      dtRefer: master.dtRefer,
      dtReceb: master.dtReceb,
      ebit: dre.ebit ?? null,
      lucroLiq: dre.lucroLiq ?? null,
      // Bancos IFRS usam 2.07; regular usa 2.03. Se ambos existem, o maior é o PL real.
      patLiq:
        bpp.patLiq !== null &&
        bpp.patLiq !== undefined &&
        bpp.patLiqIfrs !== null &&
        bpp.patLiqIfrs !== undefined
          ? Math.max(bpp.patLiq, bpp.patLiqIfrs)
          : (bpp.patLiq ?? bpp.patLiqIfrs ?? null),
      caixa: bpa.caixa ?? null,
      dividaCP: bpp.dividaCP ?? null,
      dividaLP: bpp.dividaLP ?? null,
      qtAcoes: sharesMap.get(cnpj) ?? null,
    });
  }

  writeFileSync(jsonPath, JSON.stringify(result), "utf-8");
  console.log(`  DFP ${ano}: ${result.length} empresas`);

  return new Map(result.map((f) => [f.cnpj, f]));
}
