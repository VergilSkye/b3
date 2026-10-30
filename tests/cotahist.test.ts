import { describe, expect, it } from "vitest";
import { parseCotahist } from "../src/sources/cotahist.js";

// Linha COTAHIST sintética (245 chars, padding com espaços)
// Layout base-0: [0-1] TIPREG, [2-9] DATPRE, [10-11] CODBDI, [12-23] CODNEG, [24-26] TPMERC
// [108-120] PREULT (13 dígitos, inteiro ÷ 100)
function makeLine(opts: {
  tipreg?: string;
  date?: string;
  codbdi?: string;
  ticker?: string;
  tpmerc?: string;
  preult?: number; // preço × 100
}): string {
  const tipreg = (opts.tipreg ?? "01").padEnd(2);
  const date = (opts.date ?? "20241015").padEnd(8);
  const codbdi = (opts.codbdi ?? "02").padEnd(2);
  const ticker = (opts.ticker ?? "PETR4").padEnd(12);
  const tpmerc = (opts.tpmerc ?? "010").padEnd(3);
  // preencher posições 27-107 (81 chars)
  const middle = " ".repeat(81);
  // PREULT na pos 108-120 (13 chars, zero-padded)
  const preultStr = String(opts.preult ?? 3850).padStart(13, "0");
  // restante até 245
  const tail = " ".repeat(245 - 121);
  return tipreg + date + codbdi + ticker + tpmerc + middle + preultStr + tail;
}

describe("parseCotahist", () => {
  it("parseia linha válida", () => {
    const line = makeLine({ ticker: "PETR4", date: "20241015", preult: 3850 });
    const result = parseCotahist(line);
    const prices = result.get("PETR4");
    expect(prices).toBeDefined();
    expect(prices?.length).toBe(1);
    expect(prices?.[0]?.close).toBeCloseTo(38.5);
    expect(prices?.[0]?.date).toBe("20241015");
  });

  it("ignora linha com TIPREG != 01", () => {
    const line = makeLine({ tipreg: "99", ticker: "VALE3" });
    expect(parseCotahist(line).size).toBe(0);
  });

  it("ignora linha com CODBDI != 02", () => {
    const line = makeLine({ codbdi: "10", ticker: "VALE3" });
    expect(parseCotahist(line).size).toBe(0);
  });

  it("ignora linha com TPMERC != 010", () => {
    const line = makeLine({ tpmerc: "020", ticker: "VALE3" });
    expect(parseCotahist(line).size).toBe(0);
  });

  it("ignora linha muito curta", () => {
    expect(parseCotahist("01").size).toBe(0);
  });

  it("ignora preço zero", () => {
    const line = makeLine({ preult: 0 });
    expect(parseCotahist(line).size).toBe(0);
  });

  it("agrupa múltiplos pregões do mesmo ticker", () => {
    const lines = [
      makeLine({ ticker: "ITUB4", date: "20241001", preult: 3200 }),
      makeLine({ ticker: "ITUB4", date: "20241002", preult: 3250 }),
      makeLine({ ticker: "ITUB4", date: "20241003", preult: 3300 }),
    ].join("\n");

    const result = parseCotahist(lines);
    expect(result.get("ITUB4")?.length).toBe(3);
  });

  it("ordena por data", () => {
    const lines = [
      makeLine({ ticker: "BBAS3", date: "20241003", preult: 5000 }),
      makeLine({ ticker: "BBAS3", date: "20241001", preult: 4800 }),
      makeLine({ ticker: "BBAS3", date: "20241002", preult: 4900 }),
    ].join("\n");

    const prices = parseCotahist(lines).get("BBAS3");
    expect(prices?.map((p) => p.date)).toEqual(["20241001", "20241002", "20241003"]);
  });

  it("parseia múltiplos tickers", () => {
    const lines = [
      makeLine({ ticker: "PETR4", date: "20241001", preult: 3500 }),
      makeLine({ ticker: "VALE3", date: "20241001", preult: 6000 }),
    ].join("\n");

    const result = parseCotahist(lines);
    expect(result.size).toBe(2);
    expect(result.has("PETR4")).toBe(true);
    expect(result.has("VALE3")).toBe(true);
  });
});
