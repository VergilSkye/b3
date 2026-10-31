import { describe, expect, it } from "vitest";
import { buildKnifMap } from "../src/scan-knife.js";
import type { Candidate } from "../src/scan-knife.js";
import type { ItrTrimestre } from "../src/sources/itr.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCandidate(
  ticker: string,
  overrides: Partial<Omit<Candidate, "ticker" | "liquidezMedia" | "evEbit" | "pl">> & {
    pl?: number;
    evEbit?: number;
  } = {},
): Candidate {
  return {
    ticker,
    setor: "Outros",
    liquidezMedia: 5_000_000,
    evEbit: overrides.evEbit ?? 8,
    pl: overrides.pl ?? 10,
    pvp: 1.5,
    pebit: overrides.pebit ?? null,
    dy: overrides.dy ?? null,
    divLiqPatrim: overrides.divLiqPatrim ?? null,
    pl12m: 0.1,
    patLiq: 50_000_000,
    roe: 0.15,
    mom12m: overrides.mom12m ?? null,
  };
}

function makeItr(overrides: Partial<ItrTrimestre> = {}): ItrTrimestre {
  return {
    cnpj: "00000000000000",
    dtFimExerc: "2026-09-30",
    dtReceb: "2026-10-15",
    lucroLiqTri: overrides.lucroLiqTri ?? 100_000_000,
    lucroLiqTriAA: overrides.lucroLiqTriAA ?? 80_000_000,
    dividaLiq: overrides.dividaLiq ?? 0,
    dividaLiqPrev: overrides.dividaLiqPrev ?? 0,
    ...overrides,
  };
}

const emptyMaps = {
  priceToday: new Map<string, number>(),
  low52w: new Map<string, number>(),
  mom12mMap: new Map<string, number | null>(),
  itrMap: new Map<string, ItrTrimestre>(),
  cnpjByCodigo4: new Map<string, string>(),
};

function run(
  candidates: Candidate[],
  overrides: {
    priceToday?: Map<string, number>;
    low52w?: Map<string, number>;
    mom12mMap?: Map<string, number | null>;
    itrMap?: Map<string, ItrTrimestre>;
    cnpjByCodigo4?: Map<string, string>;
    dateToday?: string;
  } = {},
) {
  return buildKnifMap(
    candidates,
    overrides.priceToday ?? emptyMaps.priceToday,
    overrides.low52w ?? emptyMaps.low52w,
    overrides.mom12mMap ?? emptyMaps.mom12mMap,
    overrides.itrMap ?? emptyMaps.itrMap,
    overrides.cnpjByCodigo4 ?? emptyMaps.cnpjByCodigo4,
    overrides.dateToday ?? "2026-10-30",
  );
}

// ── Critério (c): juros↑ ─────────────────────────────────────────────────────

describe("critério (c) juros↑", () => {
  it("LREN3: caixa líquido (divLiqPatrim < 0) → sem juros↑", () => {
    const c = makeCandidate("LREN3", { pebit: 3, pl: 10, divLiqPatrim: -0.2 });
    const result = run([c]);
    expect(result.get("LREN3")?.jurosAlerta).toBe(false);
  });

  it("VALE3: conversao > 0,40 → sem juros↑", () => {
    // conversao = P/EBIT / P/L = 6/10 = 0,60 → não < 0,40
    const c = makeCandidate("VALE3", { pebit: 6, pl: 10, divLiqPatrim: 0.8 });
    const result = run([c]);
    expect(result.get("VALE3")?.jurosAlerta).toBe(false);
  });

  it("PLPL3: conversao baixa + alavancagem alta → juros↑", () => {
    // conversao = P/EBIT / P/L = 2/10 = 0,20 < 0,40; divLiqPatrim = 1.5 > 0.5
    const c = makeCandidate("PLPL3", { pebit: 2, pl: 10, divLiqPatrim: 1.5 });
    const result = run([c]);
    expect(result.get("PLPL3")?.jurosAlerta).toBe(true);
  });

  it("P/L > 50 → juros↑ não marcado mesmo com alavancagem alta", () => {
    // conversao = 2/60 = 0,033 < 0,40; divLiqPatrim = 2.0 > 0.5; mas P/L > 50 → bloqueia
    const c = makeCandidate("XXXX3", { pebit: 2, pl: 60, divLiqPatrim: 2.0 });
    const result = run([c]);
    expect(result.get("XXXX3")?.jurosAlerta).toBe(false);
  });

  it("divLiqPatrim = 0,3 (abaixo do limiar 0,5) → sem juros↑", () => {
    const c = makeCandidate("YYYY3", { pebit: 1, pl: 10, divLiqPatrim: 0.3 });
    const result = run([c]);
    expect(result.get("YYYY3")?.jurosAlerta).toBe(false);
  });
});

// ── Critério (d): lucro não-recorrente ───────────────────────────────────────

describe("critério (d) lucro não-recorrente", () => {
  it("DY > 20% → lucroNaoRecorrente", () => {
    const c = makeCandidate("DDDD3", { dy: 0.25 });
    const result = run([c]);
    expect(result.get("DDDD3")?.lucroNaoRecorrente).toBe(true);
  });

  it("P/L > 50 → lucroNaoRecorrente", () => {
    const c = makeCandidate("PPPP3", { pl: 55 });
    const result = run([c]);
    expect(result.get("PPPP3")?.lucroNaoRecorrente).toBe(true);
  });

  it("DY normal e P/L normal → sem flag", () => {
    const c = makeCandidate("NORM3", { dy: 0.05, pl: 15 });
    const result = run([c]);
    expect(result.get("NORM3")?.lucroNaoRecorrente).toBe(false);
  });
});

// ── Critério (e): lucro trimestral ───────────────────────────────────────────

describe("critério (e) queda de lucro trimestral", () => {
  it("lucroLiqTri negativo → flag", () => {
    const cnpj = "33000167000101";
    const c = makeCandidate("VTRU3");
    const itr = makeItr({ cnpj, lucroLiqTri: -50_000_000, lucroLiqTriAA: 100_000_000 });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["VTRU", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4 });
    expect(result.get("VTRU3")?.lucroQuedaTri).toBe(true);
  });

  it("lucroLiqTri abaixo do ano anterior → flag", () => {
    const cnpj = "11111111000100";
    const c = makeCandidate("COGN3");
    const itr = makeItr({ cnpj, lucroLiqTri: 40_000_000, lucroLiqTriAA: 100_000_000 });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["COGN", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4 });
    expect(result.get("COGN3")?.lucroQuedaTri).toBe(true);
  });

  it("lucroLiqTri acima do ano anterior → sem flag", () => {
    const cnpj = "22222222000100";
    const c = makeCandidate("EGIE3");
    const itr = makeItr({ cnpj, lucroLiqTri: 120_000_000, lucroLiqTriAA: 100_000_000 });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["EGIE", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4 });
    expect(result.get("EGIE3")?.lucroQuedaTri).toBe(false);
  });

  it("sem dados ITR → sem flag", () => {
    const c = makeCandidate("NODT3");
    const result = run([c]);
    expect(result.get("NODT3")?.lucroQuedaTri).toBe(false);
  });
});

// ── Critério (f): dívida subiu ────────────────────────────────────────────────

describe("critério (f) dívida líquida subiu", () => {
  it("dívida subiu > 20% q/q → flag", () => {
    const cnpj = "44444444000100";
    const c = makeCandidate("ALLD3");
    const itr = makeItr({ cnpj, dividaLiq: 1_300_000_000, dividaLiqPrev: 1_000_000_000 });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["ALLD", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4 });
    expect(result.get("ALLD3")?.dividaSubiu).toBe(true);
  });

  it("dívida subiu < 20% q/q → sem flag", () => {
    const cnpj = "55555555000100";
    const c = makeCandidate("STAB3");
    const itr = makeItr({ cnpj, dividaLiq: 1_100_000_000, dividaLiqPrev: 1_000_000_000 });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["STAB", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4 });
    expect(result.get("STAB3")?.dividaSubiu).toBe(false);
  });

  it("passou de caixa líquido para dívida → flag", () => {
    const cnpj = "66666666000100";
    const c = makeCandidate("DBTD3");
    const itr = makeItr({ cnpj, dividaLiq: 500_000_000, dividaLiqPrev: -200_000_000 });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["DBTD", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4 });
    expect(result.get("DBTD3")?.dividaSubiu).toBe(true);
  });

  it("caixa líquido em ambos os períodos → sem flag", () => {
    const cnpj = "77777777000100";
    const c = makeCandidate("CASH3");
    const itr = makeItr({ cnpj, dividaLiq: -300_000_000, dividaLiqPrev: -200_000_000 });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["CASH", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4 });
    expect(result.get("CASH3")?.dividaSubiu).toBe(false);
  });
});

// ── Critério (g): ITR atrasado ────────────────────────────────────────────────

describe("critério (g) ITR atrasado", () => {
  it("ITR há > 120 dias → flag", () => {
    const cnpj = "88888888000100";
    const c = makeCandidate("LATE3");
    // dateToday = 2026-10-30, dtReceb = 2026-05-01 → 182 dias
    const itr = makeItr({ cnpj, dtReceb: "2026-05-01" });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["LATE", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4, dateToday: "2026-10-30" });
    expect(result.get("LATE3")?.itrAtrasado).toBe(true);
  });

  it("ITR recente → sem flag", () => {
    const cnpj = "99999999000100";
    const c = makeCandidate("ONTI3");
    // dateToday = 2026-10-30, dtReceb = 2026-10-15 → 15 dias
    const itr = makeItr({ cnpj, dtReceb: "2026-10-15" });
    const itrMap = new Map([[cnpj, itr]]);
    const cnpjByCodigo4 = new Map([["ONTI", cnpj]]);
    const result = run([c], { itrMap, cnpjByCodigo4, dateToday: "2026-10-30" });
    expect(result.get("ONTI3")?.itrAtrasado).toBe(false);
  });
});

// ── Score total e casos representativos ──────────────────────────────────────

describe("score total", () => {
  it("VTRU3-like (lucro negativo + queda aa + ITR OK) → score >= 1", () => {
    const cnpj = "33000167000101";
    const c = makeCandidate("VTRU3");
    // lucro trimestral negativo = critério (e)
    const itr = makeItr({ cnpj, lucroLiqTri: -30_000_000 });
    const result = run([c], {
      itrMap: new Map([[cnpj, itr]]),
      cnpjByCodigo4: new Map([["VTRU", cnpj]]),
    });
    const info = result.get("VTRU3");
    expect(info?.lucroQuedaTri).toBe(true);
    expect(info?.score).toBeGreaterThanOrEqual(1);
  });

  it("PLPL3-like (juros + lucro caiu) → score >= 2 (vermelho)", () => {
    const cnpj = "12345678000100";
    const c = makeCandidate("PLPL3", { pebit: 2, pl: 10, divLiqPatrim: 1.5 });
    const itr = makeItr({ cnpj, lucroLiqTri: 10_000_000, lucroLiqTriAA: 50_000_000 });
    const result = run([c], {
      itrMap: new Map([[cnpj, itr]]),
      cnpjByCodigo4: new Map([["PLPL", cnpj]]),
    });
    const info = result.get("PLPL3");
    expect(info?.jurosAlerta).toBe(true);
    expect(info?.lucroQuedaTri).toBe(true);
    expect(info?.score).toBeGreaterThanOrEqual(2);
  });

  it("empresa saudável → score 0", () => {
    const cnpj = "98765432000100";
    const c = makeCandidate("HLTH3", { pebit: 7, pl: 10, divLiqPatrim: 0.2, dy: 0.05 });
    const itr = makeItr({ cnpj, lucroLiqTri: 200_000_000, lucroLiqTriAA: 180_000_000 });
    // Sem mom12mMap → critério (a) não dispara (dados ausentes = sem penalidade)
    // Preço 20, low 15 → +33% acima mínima → critério (b) não dispara
    const result = run([c], {
      priceToday: new Map([["HLTH3", 20]]),
      low52w: new Map([["HLTH3", 15]]),
      itrMap: new Map([[cnpj, itr]]),
      cnpjByCodigo4: new Map([["HLTH", cnpj]]),
    });
    expect(result.get("HLTH3")?.score).toBe(0);
  });
});
