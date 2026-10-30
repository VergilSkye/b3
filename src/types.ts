// Dados brutos vindos do Fundamentus (após parse HTML + zod)
export interface RawStock {
  ticker: string;
  setor: string;
  liquidezMedia: number | null;
  pl: number | null; // P/L
  pvp: number | null; // P/VP
  evEbit: number | null; // EV/EBIT
  pl12m: number | null; // Lucro líquido 12m (para filtro > 0)
  patLiq: number | null; // Patrimônio líquido
  roe: number | null; // ROE (opcional, para financeiras)
}

// Ação após enriquecimento com volatilidade
export interface Stock extends RawStock {
  volatilidade: number; // anualizada, desvio-padrão log-retornos × √252
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
  corteVol: number; // 0–1; fração do quartil superior a descartar
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
