/**
 * Knife score — avaliação de risco por ticker, calculada UMA VEZ (independente da janela).
 *
 * Critérios (0–7 pts, cada um vale 1):
 *   (a) Momentum 12-1m no decil inferior dos candidatos
 *   (b) Cotação ≤ 5% acima da mínima de 52 semanas
 *   (c) juros↑: conversao = P/EBIT ÷ P/L < 0,40 E Dív.Líq/Patrim > 0,5 (não marcar se P/L > 50)
 *   (d) Lucro não-recorrente: D.Y. > 20% OU P/L > 50
 *   (e) Lucro trimestral negativo OU < mesmo trimestre do ano anterior (ITR CVM)
 *   (f) Dívida líquida subiu > 20% no último trimestre (ITR CVM)
 *   (g) Último ITR com mais de 120 dias (reporting delay)
 *
 * Escala: 0–1 🟢 · 2–3 🟡 · 4+ 🔴
 */

import type { ItrTrimestre } from "./sources/itr.js";
import type { RawStock } from "./types.js";

export interface Candidate extends RawStock {
  liquidezMedia: number;
  evEbit: number;
  pl: number;
}

export interface KnifInfo {
  score: number;
  // sinais individuais para display / auditoria
  momBaixo: boolean; // (a)
  nearMin52w: boolean; // (b)
  jurosAlerta: boolean; // (c)
  lucroNaoRecorrente: boolean; // (d)
  lucroQuedaTri: boolean; // (e)
  dividaSubiu: boolean; // (f)
  itrAtrasado: boolean; // (g)
  conversao: number | null; // P/EBIT / P/L para display
}

/** Milissegundos em um dia. */
const MS_PER_DAY = 86_400_000;

/**
 * Constrói um Map<ticker, KnifInfo> a partir dos candidatos e mapas de preço/momentum.
 *
 * @param candidates  lista de candidatos pré-filtrados (sem financeiras)
 * @param priceToday  preço mais recente por ticker
 * @param low52w      mínima de 52 semanas por ticker
 * @param mom12mMap   momentum 12-1m por ticker (pode ser null se sem dados)
 * @param itrMap      trimestres ITR por CNPJ (14 dígitos)
 * @param cnpjByCodigo4  raiz do ticker (4 letras) → CNPJ 14 dígitos
 * @param dateToday   data de referência "AAAA-MM-DD" (para critério g)
 */
export function buildKnifMap(
  candidates: Candidate[],
  priceToday: Map<string, number>,
  low52w: Map<string, number>,
  mom12mMap: Map<string, number | null>,
  itrMap: Map<string, ItrTrimestre>,
  cnpjByCodigo4: Map<string, string>,
  dateToday: string,
): Map<string, KnifInfo> {
  // Limiar do decil inferior de momentum (entre candidatos com dados)
  const moms = candidates
    .map((c) => mom12mMap.get(c.ticker) ?? null)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const decileIdx = Math.max(0, Math.floor(moms.length * 0.1) - 1);
  const momThreshold = moms[decileIdx] ?? -Number.POSITIVE_INFINITY;

  const hoje = new Date(`${dateToday}T12:00:00Z`);
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

    // (c) juros↑: conversao = P/EBIT ÷ P/L < 0,40 E Dív.Líq/Patrim > 0,5
    //     Não marcar se P/L > 50 (critério d já cobre lucro não-recorrente)
    const conversao = c.pebit !== null && c.pebit > 0 && c.pl > 0 ? c.pebit / c.pl : null;
    const jurosAlerta =
      conversao !== null && conversao < 0.4 && (c.divLiqPatrim ?? 0) > 0.5 && c.pl <= 50;

    // (d) Lucro não-recorrente: D.Y. > 20% OU P/L > 50
    const lucroNaoRecorrente = (c.dy !== null && c.dy > 0.2) || c.pl > 50;

    // (e–g) Dados trimestrais via ITR CVM
    const cnpj = cnpjByCodigo4.get(c.ticker.slice(0, 4));
    const itr = cnpj ? itrMap.get(cnpj) : undefined;

    // (e) Lucro trimestral negativo OU < mesmo trimestre do ano anterior
    let lucroQuedaTri = false;
    if (itr?.lucroLiqTri !== undefined && itr.lucroLiqTri !== null) {
      if (itr.lucroLiqTri < 0) {
        lucroQuedaTri = true;
      } else if (itr.lucroLiqTriAA !== null && itr.lucroLiqTri < itr.lucroLiqTriAA) {
        lucroQuedaTri = true;
      }
    }

    // (f) Dívida líquida subiu > 20% no trimestre (só se houve dívida > 0 nos dois períodos,
    //     ou transição de caixa líquido para dívida líquida)
    let dividaSubiu = false;
    if (
      itr?.dividaLiq !== undefined &&
      itr.dividaLiq !== null &&
      itr?.dividaLiqPrev !== undefined &&
      itr.dividaLiqPrev !== null
    ) {
      const dl = itr.dividaLiq;
      const dlPrev = itr.dividaLiqPrev;
      if (dl > 0 && dlPrev > 0 && dl > dlPrev * 1.2) dividaSubiu = true;
      else if (dl > 0 && dlPrev <= 0) dividaSubiu = true; // passou de caixa para dívida
    }

    // (g) Último ITR recebido há mais de 120 dias
    let itrAtrasado = false;
    if (itr?.dtReceb) {
      const dtR = new Date(`${itr.dtReceb}T12:00:00Z`);
      const diasAtraso = (hoje.getTime() - dtR.getTime()) / MS_PER_DAY;
      if (diasAtraso > 120) itrAtrasado = true;
    }

    const score = [
      momBaixo,
      nearMin52w,
      jurosAlerta,
      lucroNaoRecorrente,
      lucroQuedaTri,
      dividaSubiu,
      itrAtrasado,
    ].filter(Boolean).length;

    knifMap.set(c.ticker, {
      score,
      momBaixo,
      nearMin52w,
      jurosAlerta,
      lucroNaoRecorrente,
      lucroQuedaTri,
      dividaSubiu,
      itrAtrasado,
      conversao,
    });
  }

  return knifMap;
}
