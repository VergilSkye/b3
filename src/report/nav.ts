import { statSync } from "node:fs";

export type PageKind = "ranking" | "backtest" | "scan";

// Relative URLs de cada página para as outras
const HREFS: Record<PageKind, Partial<Record<PageKind, string>>> = {
  ranking: { backtest: "backtest/", scan: "scan/" },
  backtest: { ranking: "../", scan: "../scan/" },
  scan: { ranking: "../", backtest: "../backtest/" },
};

const LABELS: Record<PageKind, string> = {
  ranking: "Ranking",
  backtest: "Backtest",
  scan: "Scan CB",
};

/** Lê a data de modificação de um arquivo HTML já gerado. Retorna undefined se não existir. */
export function htmlMtime(path: string): string | undefined {
  try {
    return statSync(path).mtime.toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return undefined;
  }
}

/** CSS compartilhado da nav — injetar dentro de <style> de cada página. */
export const NAV_CSS = `
  .site-nav { display:flex; align-items:center; gap:1.5rem; padding:.5rem 0 .75rem; border-bottom:2px solid #e8e8e8; margin-bottom:1.75rem; flex-wrap:wrap; }
  .nav-brand { font-weight:700; color:#222; font-size:.95rem; letter-spacing:.02em; margin-right:.25rem; }
  .nav-links { display:flex; gap:.25rem; align-items:center; flex-wrap:wrap; }
  .nav-pill { display:inline-block; padding:.25rem .75rem; border-radius:99px; font-size:.82rem; text-decoration:none; border:1px solid transparent; transition:background .15s; }
  .nav-pill-active { background:#222; color:#fff; font-weight:600; cursor:default; }
  .nav-pill-link { color:#0066cc; border-color:#cce0ff; background:#f0f7ff; }
  .nav-pill-link:hover { background:#daeeff; }
  .nav-date { font-size:.7rem; color:#888; margin-left:.3rem; }
`;

/**
 * Gera o bloco <nav> da página.
 *
 * @param active   Página atual (fica destacada como pill escuro)
 * @param dates    Mapa opcional com a data de última modificação de cada página
 *                 (ex.: { backtest: "15/10/2026", scan: "30/10/2026" })
 */
export function navHtml(active: PageKind, dates: Partial<Record<PageKind, string>> = {}): string {
  const pages: PageKind[] = ["ranking", "backtest", "scan"];
  const hrefs = HREFS[active];

  const items = pages
    .map((p) => {
      const date = dates[p] ? `<span class="nav-date">${dates[p]}</span>` : "";
      if (p === active) {
        return `<span class="nav-pill nav-pill-active">${LABELS[p]}${date}</span>`;
      }
      const href = hrefs[p] ?? "#";
      return `<a href="${href}" class="nav-pill nav-pill-link">${LABELS[p]}${date}</a>`;
    })
    .join("\n    ");

  return `<nav class="site-nav">
  <span class="nav-brand">quant-b3</span>
  <div class="nav-links">
    ${items}
  </div>
</nav>`;
}
