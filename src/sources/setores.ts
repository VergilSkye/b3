import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { retry } from "../utils/retry.js";

const FUNDAMENTUS_URL = "https://www.fundamentus.com.br/resultado.php";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// TTL de 30 dias — setores mudam raramente
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Setores extraídos de buscaavancada.php (opções do <select name="setor">)
// IDs financeiros: 20 (Intermediários Financeiros), 31 (Previdência e Seguros),
//                  37 (Serviços Financeiros Diversos)
const TODOS_SETORES: Array<{ id: number; nome: string }> = [
  { id: 1, nome: "Agropecuária" },
  { id: 2, nome: "Água e Saneamento" },
  { id: 3, nome: "Alimentos Processados" },
  { id: 4, nome: "Serv.Méd.Hospit. Análises e Diagnósticos" },
  { id: 5, nome: "Automóveis e Motocicletas" },
  { id: 6, nome: "Bebidas" },
  { id: 7, nome: "Comércio" },
  { id: 8, nome: "Comércio e Distribuição" },
  { id: 9, nome: "Computadores e Equipamentos" },
  { id: 10, nome: "Construção Civil" },
  { id: 11, nome: "Construção e Engenharia" },
  { id: 12, nome: "Diversos" },
  { id: 13, nome: "Embalagens" },
  { id: 14, nome: "Energia Elétrica" },
  { id: 15, nome: "Equipamentos" },
  { id: 16, nome: "Exploração de Imóveis" },
  { id: 17, nome: "Gás" },
  { id: 18, nome: "Holdings Diversificadas" },
  { id: 19, nome: "Hoteis e Restaurantes" },
  { id: 20, nome: "Intermediários Financeiros" },
  { id: 21, nome: "Madeira e Papel" },
  { id: 22, nome: "Máquinas e Equipamentos" },
  { id: 23, nome: "Materiais Diversos" },
  { id: 24, nome: "Material de Transporte" },
  { id: 25, nome: "Medicamentos e Outros Produtos" },
  { id: 26, nome: "Mídia" },
  { id: 27, nome: "Mineração" },
  { id: 28, nome: "Outros" },
  { id: 29, nome: "Outros Títulos" },
  { id: 30, nome: "Petróleo, Gás e Biocombustíveis" },
  { id: 31, nome: "Previdência e Seguros" },
  { id: 32, nome: "Produtos de Uso Pessoal e de Limpeza" },
  { id: 33, nome: "Programas e Serviços" },
  { id: 34, nome: "Químicos" },
  { id: 35, nome: "Securitizadoras de Recebíveis" },
  { id: 36, nome: "Serviços Diversos" },
  { id: 37, nome: "Serviços Financeiros Diversos" },
  { id: 38, nome: "Siderurgia e Metalurgia" },
  { id: 39, nome: "Tecidos, Vestuário e Calçados" },
  { id: 40, nome: "Telecomunicações" },
  { id: 41, nome: "Transporte" },
  { id: 42, nome: "Utilidades Domésticas" },
  { id: 43, nome: "Viagens e Lazer" },
];

interface SetorCache {
  geradoEm: string;
  mapa: Record<string, string>; // ticker → nome do setor
}

async function fetchTikersDoSetor(id: number): Promise<string[]> {
  const html = await retry(async () => {
    const res = await fetch(`${FUNDAMENTUS_URL}?setor=${id}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`Fundamentus setor ${id}: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder("latin1").decode(buf);
  });

  const $ = cheerio.load(html);
  return $("#resultado tbody tr")
    .map((_i, el) => {
      const cell = $(el).find("td").first();
      const ticker = (cell.find("a").text().trim() || cell.text().trim()).toUpperCase();
      return ticker;
    })
    .get()
    .filter((t) => t.length >= 4);
}

/**
 * Constrói mapa ticker → nome-do-setor consultando resultado.php?setor={id}
 * para cada um dos 43 setores do Fundamentus.
 *
 * Resultado cacheado em data/cache/setores.json por 30 dias.
 */
export async function buildSetorMap(cacheDir: string): Promise<Map<string, string>> {
  const cachePath = join(cacheDir, "setores.json");

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as SetorCache;
    const idadeMs = Date.now() - new Date(cached.geradoEm).getTime();
    if (idadeMs < CACHE_TTL_MS) {
      console.log("  Setores: usando cache (válido por 30 dias)");
      return new Map(Object.entries(cached.mapa));
    }
  }

  console.log(`  Buscando setores do Fundamentus (${TODOS_SETORES.length} setores)...`);
  const mapa: Record<string, string> = {};

  for (const { id, nome } of TODOS_SETORES) {
    const tickers = await fetchTikersDoSetor(id);
    for (const t of tickers) mapa[t] = nome;
    // Pausa gentil entre requisições
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }

  const total = Object.keys(mapa).length;
  console.log(`  ${total} tickers mapeados para setores`);

  mkdirSync(cacheDir, { recursive: true });
  const cacheData: SetorCache = { geradoEm: new Date().toISOString(), mapa };
  writeFileSync(cachePath, JSON.stringify(cacheData), "utf-8");

  return new Map(Object.entries(mapa));
}
