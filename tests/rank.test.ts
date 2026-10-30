import { describe, expect, it } from "vitest";
import { rankBy, scoreByRanks } from "../src/utils/rank.js";

describe("rankBy", () => {
  it("rank 1 = menor valor", () => {
    const items = [{ v: 3 }, { v: 1 }, { v: 2 }];
    const result = rankBy(items, "v");
    expect(result.find((r) => r.v === 1)?.rank).toBe(1);
    expect(result.find((r) => r.v === 2)?.rank).toBe(2);
    expect(result.find((r) => r.v === 3)?.rank).toBe(3);
  });

  it("null recebe pior rank", () => {
    const items = [{ v: 5 as number | null }, { v: null }, { v: 2 as number | null }];
    const result = rankBy(items, "v");
    expect(result.find((r) => r.v === null)?.rank).toBe(items.length + 1);
  });

  it("empate: mesmo rank para valores iguais", () => {
    const items = [{ v: 1 }, { v: 1 }, { v: 3 }];
    const result = rankBy(items, "v");
    const ranks = result.filter((r) => r.v === 1).map((r) => r.rank);
    expect(ranks).toEqual([1, 1]);
  });
});

describe("scoreByRanks", () => {
  it("score é soma dos ranks de cada métrica", () => {
    const items = [
      { a: 1, b: 2 },
      { a: 2, b: 1 },
      { a: 3, b: 3 },
    ];
    const result = scoreByRanks(items, ["a", "b"]);
    // primeiro item: rank_a=1, rank_b=2 → score=3
    // segundo item: rank_a=2, rank_b=1 → score=3
    // terceiro: rank_a=3, rank_b=3 → score=6
    expect(result.find((r) => r.a === 3)?.score).toBe(6);
  });
});
