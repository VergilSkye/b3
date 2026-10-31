import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { enriquecerComVolMock, selectPortfolio } from "../src/strategy.js";
import type { RawStock } from "../src/types.js";

function makeStock(overrides: Partial<RawStock> & { ticker: string }): RawStock {
  return {
    setor: "Energia Elétrica",
    liquidezMedia: 5_000_000,
    pl: 10,
    pvp: 1.5,
    evEbit: 8,
    pl12m: 1_000_000,
    patLiq: 50_000_000,
    roe: 0.15,
    mom12m: null,
    ...overrides,
  };
}

const rawGerais: RawStock[] = [
  makeStock({ ticker: "AABB3", evEbit: 4, pl: 8, liquidezMedia: 2_000_000 }),
  makeStock({ ticker: "CCDD3", evEbit: 6, pl: 12, liquidezMedia: 3_000_000 }),
  makeStock({ ticker: "EEFF3", evEbit: 10, pl: 20, liquidezMedia: 4_000_000 }),
  makeStock({ ticker: "GGHH3", evEbit: 2, pl: 5, liquidezMedia: 5_000_000 }),
  makeStock({ ticker: "IIJJ3", evEbit: 15, pl: 25, liquidezMedia: 6_000_000 }),
];

const rawFinanceiras: RawStock[] = [
  makeStock({
    ticker: "BNCO3",
    setor: "Bancos",
    evEbit: null,
    pvp: 1.2,
    pl: 7,
    liquidezMedia: 2_000_000,
  }),
  makeStock({
    ticker: "SGUR3",
    setor: "Seguros",
    evEbit: null,
    pvp: 1.8,
    pl: 10,
    liquidezMedia: 3_000_000,
  }),
];

const acoes = enriquecerComVolMock([...rawGerais, ...rawFinanceiras]);

describe("enriquecerComVolMock", () => {
  it("atribui grupo correto", () => {
    const bancos = acoes.filter((a) => a.grupo === "financeiro");
    expect(bancos.map((a) => a.ticker).sort()).toEqual(["BNCO3", "SGUR3"]);
  });

  it("atribui volatilidade mockada", () => {
    expect(acoes.every((a) => a.volatilidade === 0.3)).toBe(true);
  });
});

describe("selectPortfolio", () => {
  const cfg = { ...DEFAULT_CONFIG, nAcoes: 3, nAcoesFin: 2 };
  const result = selectPortfolio(acoes, cfg);

  it("retorna grupos separados", () => {
    expect(result.geral.length).toBeGreaterThan(0);
    expect(result.financeiros.length).toBeGreaterThan(0);
  });

  it("geral não contém financeiras", () => {
    expect(result.geral.every((a) => a.grupo === "geral")).toBe(true);
  });

  it("financeiros não contém gerais", () => {
    expect(result.financeiros.every((a) => a.grupo === "financeiro")).toBe(true);
  });

  it("respeita top N", () => {
    expect(result.geral.length).toBeLessThanOrEqual(cfg.nAcoes);
    expect(result.financeiros.length).toBeLessThanOrEqual(cfg.nAcoesFin);
  });

  it("melhor score primeiro no geral (GGHH3: evEbit=2, pl=5 → rank mais baixo)", () => {
    expect(result.geral[0]?.ticker).toBe("GGHH3");
  });

  it("filtra ação com pl negativo", () => {
    const comPLNeg = enriquecerComVolMock([
      ...rawGerais,
      makeStock({ ticker: "XXXX3", pl: -5, patLiq: 1_000_000 }),
    ]);
    const r = selectPortfolio(comPLNeg, cfg);
    expect(r.geral.find((a) => a.ticker === "XXXX3")).toBeUndefined();
  });

  it("filtra ação com patrimônio líquido negativo", () => {
    const comPLNeg = enriquecerComVolMock([
      ...rawGerais,
      makeStock({ ticker: "YYYY3", pl: 5, patLiq: -1_000_000 }),
    ]);
    const r = selectPortfolio(comPLNeg, cfg);
    expect(r.geral.find((a) => a.ticker === "YYYY3")).toBeUndefined();
  });

  it("filtra ação com liquidez abaixo do mínimo", () => {
    const comBaixaLiq = enriquecerComVolMock([
      ...rawGerais,
      makeStock({ ticker: "ZZZZ3", liquidezMedia: 500_000 }),
    ]);
    const r = selectPortfolio(comBaixaLiq, cfg);
    expect(r.geral.find((a) => a.ticker === "ZZZZ3")).toBeUndefined();
  });

  it("filtra ação com evEbit negativo (EBIT negativo = prejuízo operacional)", () => {
    const c = enriquecerComVolMock([
      ...rawGerais,
      makeStock({ ticker: "NEGV3", evEbit: -5, pl: 3 }),
    ]);
    const r = selectPortfolio(c, { ...cfg, nAcoes: 10 });
    expect(r.geral.find((a) => a.ticker === "NEGV3")).toBeUndefined();
  });

  it("filtra ação com evEbit zero (dado ausente no Fundamentus)", () => {
    const c = enriquecerComVolMock([
      ...rawGerais,
      makeStock({ ticker: "ZERO3", evEbit: 0, pl: 3 }),
    ]);
    const r = selectPortfolio(c, { ...cfg, nAcoes: 10 });
    expect(r.geral.find((a) => a.ticker === "ZERO3")).toBeUndefined();
  });

  it("filtra ação com evEbit nulo", () => {
    const c = enriquecerComVolMock([
      ...rawGerais,
      makeStock({ ticker: "NULE3", evEbit: null, pl: 3 }),
    ]);
    const r = selectPortfolio(c, { ...cfg, nAcoes: 10 });
    expect(r.geral.find((a) => a.ticker === "NULE3")).toBeUndefined();
  });

  it("financeiras não exigem evEbit > 0", () => {
    const c = enriquecerComVolMock([
      ...rawFinanceiras,
      makeStock({ ticker: "BNCO5", setor: "Bancos", evEbit: null, pvp: 1.0, pl: 6 }),
    ]);
    const r = selectPortfolio(c, { ...cfg, nAcoesFin: 10 });
    expect(r.financeiros.find((a) => a.ticker === "BNCO5")).toBeDefined();
  });

  it("deduplica classes: mantém mais líquida (TAEE3 > TAEE4 > TAEE11)", () => {
    const comDupe = enriquecerComVolMock([
      makeStock({ ticker: "TAEE3", liquidezMedia: 9_000_000, evEbit: 8, pl: 9 }),
      makeStock({ ticker: "TAEE4", liquidezMedia: 7_000_000, evEbit: 8, pl: 9 }),
      makeStock({ ticker: "TAEE11", liquidezMedia: 5_000_000, evEbit: 8, pl: 9 }),
    ]);
    const r = selectPortfolio(comDupe, { ...cfg, nAcoes: 10 });
    const taees = r.geral.filter((a) => a.ticker.startsWith("TAEE"));
    expect(taees.length).toBe(1);
    expect(taees[0]?.ticker).toBe("TAEE3");
  });
});
