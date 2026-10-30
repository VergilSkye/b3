/**
 * Converte string numérica no formato brasileiro para number | null.
 * Exemplos: "1.234,56" → 1234.56 | "12,5%" → 0.125 | "-" → null | "" → null
 */
export function parseBR(s: string | undefined | null): number | null {
  if (s == null) return null;

  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "-") return null;

  const isPercent = trimmed.endsWith("%");
  const clean = trimmed
    .replace("%", "")
    .replace(/\./g, "") // separador de milhar
    .replace(",", ".") // separador decimal
    .trim();

  const n = Number(clean);
  if (!Number.isFinite(n)) return null;

  return isPercent ? n / 100 : n;
}
