import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { retry } from "../utils/retry.js";

const BASE_URL = "https://www.fundamentus.com.br";
const RESULTADO_URL = `${BASE_URL}/resultado.php`;
const BUSCA_URL = `${BASE_URL}/buscaavancada.php`;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const DELAY_MS = 3000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface SetorOption {
  id: number;
  nome: string;
}

interface SetorCache {
  geradoEm: string;
  mapa: Record<string, string>; // ticker → setor
}

/** Busca as opções do <select name="setor"> na buscaavancada.php */
async function fetchSetorOptions(): Promise<SetorOption[]> {
  const html = await retry(async () => {
    const res = await fetch(BUSCA_URL, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Fundamentus buscaavancada HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder("latin1").decode(buf);
  });

  const $ = cheerio.load(html);
  const setores: SetorOption[] = [];

  $('select[name="setor"] option').each((_i, el) => {
    const id = Number($(el).attr("value"));
    const nome = $(el).text().trim();
    if (id > 0 && nome) setores.push({ id, nome });
  });

  return setores;
}

/** Extrai tickers da tabela #resultado de um HTML de resposta do Fundamentus */
function parseTickers(html: string): string[] {
  const $ = cheerio.load(html);
  const tickers: string[] = [];
  $("#resultado tbody tr").each((_i, el) => {
    const cell = $(el).find("td").first();
    const t = (cell.find("a").text().trim() || cell.text().trim()).toUpperCase();
    if (t.length >= 4) tickers.push(t);
  });
  return tickers;
}

/**
 * Constrói mapa ticker → setor fazendo um POST por setor no Fundamentus.
 * Resultado cacheado em {cacheDir}/setor_map.json (TTL 30 dias).
 */
export async function buildSetorMap(cacheDir: string): Promise<Map<string, string>> {
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "setor_map.json");

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as SetorCache;
    const idadeMs = Date.now() - new Date(cached.geradoEm).getTime();
    if (idadeMs < CACHE_TTL_MS) {
      const n = Object.keys(cached.mapa).length;
      console.log(`  Setor map: cache (${n} tickers)`);
      return new Map(Object.entries(cached.mapa));
    }
  }

  console.log("  Buscando setores do Fundamentus...");
  const setores = await fetchSetorOptions();
  console.log(`  ${setores.length} setores encontrados`);

  const mapa: Record<string, string> = {};

  for (const { id, nome } of setores) {
    await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS));

    const html = await retry(async () => {
      const res = await fetch(RESULTADO_URL, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: BUSCA_URL,
        },
        body: `setor=${id}&negociada=ON&ordem=1&x=28&y=16`,
      });
      if (!res.ok) throw new Error(`Fundamentus setor ${id} HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return new TextDecoder("latin1").decode(buf);
    });

    const tickers = parseTickers(html);
    for (const t of tickers) mapa[t] = nome;
    console.log(`  [${String(id).padStart(2)}] ${nome}: ${tickers.length} tickers`);
  }

  const cache: SetorCache = { geradoEm: new Date().toISOString(), mapa };
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  console.log(`  Setor map salvo: ${Object.keys(mapa).length} tickers totais`);

  return new Map(Object.entries(mapa));
}
