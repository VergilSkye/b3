/**
 * Atribui ranks (1 = menor valor = melhor) a um array de objetos por uma chave numérica.
 * Itens com valor null recebem rank = items.length + 1 (pior posição).
 * Em caso de empate, todos recebem o mesmo rank (dense rank).
 */
export function rankBy<T extends object>(items: T[], key: keyof T): (T & { rank: number })[] {
  const sorted = [...items].sort((a, b) => {
    const av = a[key] as number | null;
    const bv = b[key] as number | null;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  });

  const worstRank = items.length + 1;
  let currentRank = 1;

  return sorted.map((item, i) => {
    const prev = sorted[i - 1];
    if (i > 0 && prev != null && prev[key] !== item[key]) {
      currentRank = i + 1;
    }
    const rank = (item[key] as number | null) == null ? worstRank : currentRank;
    return { ...item, rank };
  });
}

/**
 * Soma os ranks de múltiplas métricas para cada item (score composto).
 * Menor score = melhor.
 */
export function scoreByRanks<T extends object>(
  items: T[],
  metricas: (keyof T)[],
): (T & { score: number })[] {
  const scores = new Array<number>(items.length).fill(0);
  const worstRank = items.length + 1;

  for (const metrica of metricas) {
    // Ordenar índices pelo valor da métrica
    const indices = items.map((_, i) => i);
    indices.sort((a, b) => {
      const av = items[a]?.[metrica] as number | null | undefined;
      const bv = items[b]?.[metrica] as number | null | undefined;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    });

    let currentRank = 1;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i] ?? 0;
      const prevIdx = indices[i - 1];
      if (i > 0 && prevIdx !== undefined && items[prevIdx]?.[metrica] !== items[idx]?.[metrica]) {
        currentRank = i + 1;
      }
      const val = items[idx]?.[metrica] as number | null | undefined;
      scores[idx] = (scores[idx] ?? 0) + (val == null ? worstRank : currentRank);
    }
  }

  return items.map((item, i) => ({ ...item, score: scores[i] ?? 0 }));
}
