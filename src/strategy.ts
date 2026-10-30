import { isFinanceira } from "./config.js";
import type { Config, MetricaValor, RawStock, SelectResult, Stock } from "./types.js";
import { quantile } from "./utils/quantile.js";
import { scoreByRanks } from "./utils/rank.js";

/**
 * Função pura: recebe um array de ações (já com volatilidade preenchida)
 * e a configuração, devolve { geral, financeiros }.
 *
 * Não acessa rede, não lê arquivos — pode ser usada ao vivo e no backtest.
 */
export function selectPortfolio(acoes: Stock[], config: Config): SelectResult {
  const { liquidezMin, corteVol } = config;

  // 1. Separar grupos
  const gerais = acoes.filter((a) => a.grupo === "geral");
  const financeiras = acoes.filter((a) => a.grupo === "financeiro");

  return {
    geral: rankGroup(gerais, liquidezMin, corteVol, config.metricas, config.nAcoes),
    financeiros: rankGroup(
      financeiras,
      liquidezMin,
      corteVol,
      config.metricasFin,
      config.nAcoesFin,
    ),
  };
}

/**
 * Aplica filtros, dedupe, corte de volatilidade e ranking em um grupo.
 */
function rankGroup(
  acoes: Stock[],
  liquidezMin: number,
  corteVol: number,
  metricas: MetricaValor[],
  topN: number,
): Stock[] {
  // 2. Filtros básicos
  // Para o grupo geral, exigimos evEbit > 0: valor zero ou negativo indica dado ausente
  // ou EBIT negativo (prejuízo operacional), ambos inválidos para a estratégia.
  const exigeEvEbit = metricas.includes("evEbit");
  let filtradas = acoes.filter(
    (a) =>
      (a.liquidezMedia ?? 0) >= liquidezMin &&
      a.pl !== null &&
      a.pl > 0 &&
      a.patLiq !== null &&
      a.patLiq > 0 &&
      (!exigeEvEbit || (a.evEbit !== null && a.evEbit > 0)),
  );

  // 3. Deduplica classes da mesma empresa (raiz de 4 letras) → mais líquida
  filtradas = deduplicarClasses(filtradas);

  // 4. Corte de volatilidade: descartar quartil superior
  if (corteVol > 0 && filtradas.length > 0) {
    const vols = filtradas.map((a) => a.volatilidade);
    const limiarVol = quantile(vols, 1 - corteVol);
    if (limiarVol !== null) {
      filtradas = filtradas.filter((a) => a.volatilidade <= limiarVol);
    }
  }

  // 5. Garantir que todas as métricas usadas não sejam nulas (ao menos uma válida)
  filtradas = filtradas.filter((a) => metricas.some((m) => a[m] !== null));

  // 6. Rank composto e top N
  const scored = scoreByRanks(filtradas, metricas as (keyof Stock)[]);
  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, topN);
}

function deduplicarClasses(acoes: Stock[]): Stock[] {
  const porRaiz = new Map<string, Stock>();
  for (const acao of acoes) {
    const raiz = acao.ticker.slice(0, 4);
    const existente = porRaiz.get(raiz);
    if (existente === undefined || (acao.liquidezMedia ?? 0) > (existente.liquidezMedia ?? 0)) {
      porRaiz.set(raiz, acao);
    }
  }
  return Array.from(porRaiz.values());
}

/**
 * Enriquece RawStock[] com grupo e volatilidade (mockada para M1).
 */
export function enriquecerComVolMock(acoes: RawStock[], volMock = 0.3): Stock[] {
  return acoes.map((a) => ({
    ...a,
    volatilidade: volMock,
    grupo: isFinanceira(a.setor) ? "financeiro" : "geral",
  }));
}
