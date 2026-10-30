import { describe, expect, it } from "vitest";
import { parseBR } from "../src/utils/parseBR.js";

describe("parseBR", () => {
  it("converte número com milhar e decimal", () => {
    expect(parseBR("1.234,56")).toBe(1234.56);
  });

  it("converte percentual", () => {
    expect(parseBR("12,5%")).toBeCloseTo(0.125);
  });

  it("converte número negativo", () => {
    expect(parseBR("-1.500,00")).toBe(-1500);
  });

  it("retorna null para traço", () => {
    expect(parseBR("-")).toBeNull();
  });

  it("retorna null para string vazia", () => {
    expect(parseBR("")).toBeNull();
  });

  it("retorna null para null/undefined", () => {
    expect(parseBR(null)).toBeNull();
    expect(parseBR(undefined)).toBeNull();
  });

  it("converte inteiro sem decimal", () => {
    expect(parseBR("42")).toBe(42);
  });

  it("converte número sem milhar", () => {
    expect(parseBR("3,14")).toBe(3.14);
  });
});
