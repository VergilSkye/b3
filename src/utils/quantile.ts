import { quantile as ssQuantile } from "simple-statistics";

/**
 * Retorna o valor do quantil p (0–1) de um array de números.
 * Retorna null se o array estiver vazio.
 */
export function quantile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  return ssQuantile(values, p);
}
