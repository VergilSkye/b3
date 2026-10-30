import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

const DATA_DIR = "data/rankings";

export interface Diff {
  entradas: string[];
  saidas: string[];
}

export interface DiffResult {
  geral: Diff;
  financeiros: Diff;
}

interface CsvRow {
  ticker: string;
  grupo: string;
}

function tickersPorGrupo(csvPath: string, grupo: "geral" | "financeiro"): string[] {
  const content = readFileSync(csvPath, "utf-8");
  const rows = parse(content, { columns: true, skip_empty_lines: true }) as CsvRow[];
  return rows.filter((r) => r.grupo === grupo).map((r) => r.ticker);
}

function mesAnterior(mesAtual: string): string | null {
  const [year, month] = mesAtual.split("-").map(Number);
  if (!year || !month) return null;
  const d = new Date(year, month - 2); // month-2 pois Date é 0-indexed
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function calcDiff(anterior: string[], atual: string[]): Diff {
  const antSet = new Set(anterior);
  const atualSet = new Set(atual);
  return {
    entradas: atual.filter((t) => !antSet.has(t)),
    saidas: anterior.filter((t) => !atualSet.has(t)),
  };
}

export function calcDiffResult(mesAtual: string, csvAtual: string): DiffResult {
  const mesAnt = mesAnterior(mesAtual);
  const csvAnt = mesAnt ? join(DATA_DIR, `${mesAnt}.csv`) : null;

  if (!csvAnt || !existsSync(csvAnt)) {
    return { geral: { entradas: [], saidas: [] }, financeiros: { entradas: [], saidas: [] } };
  }

  return {
    geral: calcDiff(tickersPorGrupo(csvAnt, "geral"), tickersPorGrupo(csvAtual, "geral")),
    financeiros: calcDiff(
      tickersPorGrupo(csvAnt, "financeiro"),
      tickersPorGrupo(csvAtual, "financeiro"),
    ),
  };
}

export function ultimoCsv(): { mes: string; path: string } | null {
  if (!existsSync(DATA_DIR)) return null;
  const files = readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
    .sort()
    .reverse();
  const latest = files[0];
  if (!latest) return null;
  return { mes: latest.replace(".csv", ""), path: join(DATA_DIR, latest) };
}
