import type { Config } from "./types.js";

export const DEFAULT_CONFIG: Config = {
  liquidezMin: 1_000_000,
  nAcoes: 20,
  corteVol: 0.25,
  corteMomento: 0.1, // exclui o pior decil de momentum (12-1m)
  metricas: ["evEbit", "pl"],

  nAcoesFin: 5,
  metricasFin: ["pvp", "pl"],
};

// Heurística de setor para financeiras (Fundamentus)
export const SETORES_FINANCEIROS = ["banco", "seguro", "financ", "previdência", "crédito"];

export function isFinanceira(setor: string): boolean {
  const s = setor.toLowerCase();
  return SETORES_FINANCEIROS.some((termo) => s.includes(termo));
}
