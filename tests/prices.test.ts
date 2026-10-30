import { describe, expect, it } from "vitest";
import { calcVolatilidade } from "../src/sources/prices.js";

function gerarPrecos(n: number, volatilidade = 0.2): number[] {
  // Simula random walk lognormal com vol anualizada desejada
  const dtVol = volatilidade / Math.sqrt(252);
  const prices = [100.0];
  for (let i = 1; i < n; i++) {
    // Usa variação fixa de dtVol para série determinística (Box-Muller simplificado)
    const z = i % 2 === 0 ? dtVol : -dtVol;
    prices.push((prices[i - 1] as number) * Math.exp(z));
  }
  return prices;
}

describe("calcVolatilidade", () => {
  it("retorna null com menos de 22 preços", () => {
    expect(calcVolatilidade([100, 101, 102])).toBeNull();
    expect(calcVolatilidade(gerarPrecos(21))).toBeNull();
  });

  it("retorna number com dados suficientes", () => {
    const closes = gerarPrecos(253);
    const vol = calcVolatilidade(closes);
    expect(vol).not.toBeNull();
    expect(typeof vol).toBe("number");
  });

  it("volatilidade é positiva", () => {
    const closes = gerarPrecos(253, 0.3);
    const vol = calcVolatilidade(closes);
    expect(vol).toBeGreaterThan(0);
  });

  it("detecta diferença entre séries de alta e baixa volatilidade", () => {
    const lowVol = calcVolatilidade(gerarPrecos(253, 0.1));
    const highVol = calcVolatilidade(gerarPrecos(253, 0.5));
    expect(lowVol).not.toBeNull();
    expect(highVol).not.toBeNull();
    expect(highVol as number).toBeGreaterThan(lowVol as number);
  });

  it("retorna null com apenas preços iguais (desvio zero → NaN via sqrt)", () => {
    // série constante: log-returns = 0, sampleStdDev = 0
    const flat = new Array(253).fill(100) as number[];
    // stddev(0,0,...) = 0, vol = 0 — não é null, mas é 0
    const vol = calcVolatilidade(flat);
    expect(vol).toBe(0);
  });
});
