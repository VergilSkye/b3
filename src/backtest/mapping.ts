import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retry } from "../utils/retry.js";

const B3_API =
  "https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetInitialCompanies/eyJsYW5ndWFnZSI6InB0LWJyIn0=";

// TTL de 30 dias — lista de empresas muda pouco
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface B3Company {
  codeCVM: string;
  issuingCompany: string; // 4-letter issuer code (prefix do ticker)
  companyName: string;
  cnpj: string; // 14 dígitos sem formatação
  status: string; // "A" = ativo
}

interface CacheFile {
  geradoEm: string;
  empresas: B3Company[];
}

export interface TickerInfo {
  codigo4: string; // ex: "PETR"
  denom: string;
}

/** Remove tudo que não for dígito de um CNPJ (ex: "33.000.167/0001-01" → "33000167000101"). */
export function normCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "");
}

export interface B3Maps {
  porCnpj: Map<string, TickerInfo>; // cnpj 14 dígitos → TickerInfo
  porCdCvm: Map<string, TickerInfo>; // codeCVM sem zeros → TickerInfo
}

/**
 * Baixa a lista de empresas listadas na B3 e constrói dois mapas de lookup:
 * - porCnpj: CNPJ 14 dígitos → TickerInfo
 * - porCdCvm: código CVM (sem zeros à esquerda) → TickerInfo  ← fallback para CNPJs truncados
 *
 * Resultado cacheado em {cacheDir}/b3_companies.json (TTL 30 dias).
 */
export async function buildB3Maps(cacheDir: string): Promise<B3Maps> {
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "b3_companies.json");

  let empresas: B3Company[] | null = null;

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as CacheFile;
    const idadeMs = Date.now() - new Date(cached.geradoEm).getTime();
    if (idadeMs < CACHE_TTL_MS) {
      empresas = cached.empresas;
      console.log(`  B3 companies: cache (${empresas.length} empresas)`);
    }
  }

  if (!empresas) {
    console.log("  Baixando lista de empresas B3...");
    const data = await retry(async () => {
      const res = await fetch(B3_API);
      if (!res.ok) throw new Error(`B3 companies HTTP ${res.status}`);
      return res.json() as Promise<{ results: B3Company[] }>;
    });
    empresas = data.results ?? [];
    console.log(`  ${empresas.length} empresas listadas na B3`);
    const cache: CacheFile = { geradoEm: new Date().toISOString(), empresas };
    writeFileSync(cachePath, JSON.stringify(cache), "utf-8");
  }

  const porCnpj = new Map<string, TickerInfo>();
  const porCdCvm = new Map<string, TickerInfo>();

  for (const emp of empresas) {
    if (!emp.issuingCompany || emp.issuingCompany.length < 4) continue;
    const info: TickerInfo = {
      codigo4: emp.issuingCompany.toUpperCase(),
      denom: emp.companyName,
    };
    const cnpj = emp.cnpj.replace(/\D/g, "");
    if (cnpj.length === 14) porCnpj.set(cnpj, info);
    // codeCVM sem zeros à esquerda como chave secundária
    const cdCvm = String(Number(emp.codeCVM) || 0);
    if (cdCvm !== "0") porCdCvm.set(cdCvm, info);
  }

  return { porCnpj, porCdCvm };
}

/**
 * Busca TickerInfo pelo CNPJ (principal) ou cdCvm (fallback).
 * cnpjFormatado pode estar no formato CVM "33.000.167/0001-01" ou raw 14 dígitos.
 */
export function lookupTicker(
  cnpjFormatado: string,
  cdCvm: string,
  maps: B3Maps,
): TickerInfo | undefined {
  return maps.porCnpj.get(normCnpj(cnpjFormatado)) ?? maps.porCdCvm.get(cdCvm);
}
