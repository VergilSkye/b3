// Dados brutos vindos do Fundamentus (após parse HTML + zod)
export interface RawStock {
  ticker: string;
  setor: string;
  liquidezMedia: number | null;
  pl: number | null; // P/L
  pvp: number | null; // P/VP
  evEbit: number | null; // EV/EBIT
  pebit: number | null; // P/EBIT (para cálculo de conversão operacional)
  dy: number | null; // Dividend Yield (fração: 0.08 = 8%)
  divLiqPatrim: number | null; // Dív.Líq/Patrim (> 0 = endividado)
  pl12m: number | null; // Margem líquida 12m (Fundamentus) ou lucro/ação (CVM)
  patLiq: number | null; // Patrimônio líquido
  roe: number | null; // ROE (opcional, para financeiras)
  mom12m: number | null; // Momentum 12-1m: retorno de 13m atrás até 1m atrás
}

// Ação após enriquecimento com volatilidade
export interface Stock extends RawStock {
  volatilidade: number | null; // anualizada, desvio-padrão log-retornos × √252; null = sem dados
  grupo: "geral" | "financeiro";
}

// Conjunto de dados de uma data específica (entrada de selectPortfolio)
export interface Snapshot {
  data: Date;
  acoes: RawStock[];
}

// Configuração da estratégia
export interface Config {
  liquidezMin: number;
  nAcoes: number;
  corteVol: number; // 0–1; fração do quartil superior a descartar (volatilidade)
  corteMomento: number; // 0–1; fração do decil inferior a descartar (momentum 12-1m)
  metricas: MetricaValor[]; // métricas do ranking geral

  nAcoesFin: number;
  metricasFin: MetricaValor[]; // métricas do ranking de financeiras
}

export type MetricaValor = "evEbit" | "pl" | "pvp" | "roe";

// Retorno de selectPortfolio
export interface SelectResult {
  geral: Stock[];
  financeiros: Stock[];
}
