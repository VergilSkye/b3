import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/sources/fundamentus.js";

const fixture = readFileSync(join(import.meta.dirname, "fixtures/fundamentus.html"), "utf-8");

describe("parseHtml", () => {
  it("parseia todas as linhas válidas da fixture", () => {
    const rows = parseHtml(fixture, 10);
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it("ao menos um ticker geral com EV/EBIT e P/L numéricos", () => {
    const rows = parseHtml(fixture, 10);
    const geral = rows.filter((r) => r.evEbit !== null && r.pl !== null);
    expect(geral.length).toBeGreaterThan(0);
  });

  it("detecta ao menos uma financeira (banco ou seguro)", () => {
    const rows = parseHtml(fixture, 10);
    const financeiras = rows.filter((r) =>
      ["banco", "seguro"].some((t) => r.setor.toLowerCase().includes(t)),
    );
    expect(financeiras.length).toBeGreaterThan(0);
  });

  it("financeiras têm EV/EBIT nulo", () => {
    const rows = parseHtml(fixture, 10);
    const bancos = rows.filter((r) => r.setor.toLowerCase().includes("banco"));
    expect(bancos.every((r) => r.evEbit === null)).toBe(true);
  });

  it("deduplica: TAEE3/TAEE4/TAEE11 presentes na fixture", () => {
    const rows = parseHtml(fixture, 10);
    const taee = rows.filter((r) => r.ticker.startsWith("TAEE"));
    expect(taee.length).toBe(3);
  });

  it("ignora linha com ticker inválido", () => {
    const html = fixture.replace(
      "<td>PETR4</td>",
      "<td>X</td>", // ticker muito curto — deve ser ignorado
    );
    const rows = parseHtml(html, 5);
    expect(rows.find((r) => r.ticker === "X")).toBeUndefined();
  });

  it("lança erro se parse retornar menos linhas que o mínimo", () => {
    expect(() => parseHtml("<html><table id='resultado'></table></html>", 1)).toThrow();
  });
});
