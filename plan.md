# PLAN.md — quant-b3: ranking quantitativo de ações da B3

> Documento de handoff. Leia inteiro antes de começar. Responda sempre em **português do Brasil**, de forma concisa e técnica.
> Trabalhe **um marco por vez**. Ao fim de cada um, rode `pnpm typecheck && pnpm test && pnpm lint` e mostre um resumo curto.

---

## 0. Decisões tomadas

| # | Decisão | Escolha | Motivo |
|---|---|---|---|
| 1 | Repo | **público** | Pages gratuito; sem dados sensíveis no repositório |
| 2 | Notificação | **Telegram** | já planejado; mais conveniente que e-mail |
| 3 | Bancos/seguradoras | **ranking separado** | EV/EBIT não se aplica a financeiras → métricas próprias: P/VP + P/L (+ ROE opcional); mesmo filtro de liquidez e volatilidade |
| 4 | Ordem de execução | **M1–M4 primeiro**, depois M5–M8 | ter produção funcionando valida a estratégia antes de investir no backtest |
| 5 | Parâmetros iniciais | geral: **20 ações**, **EV/EBIT + P/L**; financeiras: **5 ações**, **P/VP + P/L**; rebalanceamento **mensal** | ponto de partida conservador; ajustar com base no backtest (M8) |

---

## 1. Contexto

Sou dev e invisto na B3. Quero automatizar uma estratégia quantitativa de valor (sugerida pelo canal *Clube do Valor*) **sem manter servidor**: tudo roda em **GitHub Actions**, publica em **GitHub Pages** e notifica via **Telegram**. Além disso, quero um **backtest** histórico para validar e calibrar os parâmetros antes de confiar no ranking.

Stack: **Node.js 22 + TypeScript** (nada de Python).

---

## 2. A estratégia (5 passos)

1. **Universo barato e líquido**: todas as ações da B3, filtradas por liquidez média diária (2 meses) ≥ R$ 1.000.000.
2. **Tirar prejuízo**: lucro líquido 12m > 0 (P/L > 0) e patrimônio líquido > 0.
3. **Tirar as mais voláteis**: calcular a volatilidade anualizada de 12 meses (desvio-padrão dos log-retornos diários × √252) e descartar o quartil superior (`corteVol = 0.25`, configurável).
4. **Filtro de momentum (value-momentum)**: calcular retorno 12-1m (de 13 meses atrás até 1 mês atrás, excluindo o último mês) e descartar o decil inferior (`corteMomento = 0.10`, configurável). Ações sem dados de preço passam. Evita "facas caindo" — trailing P/L pode parecer barato enquanto o lucro deteriora. Baseado em Asness et al. (1997) / AQR.
5. **Ranquear por índice de valor e comprar as 20 primeiras**: score = soma dos ranks de EV/EBIT e P/L; menor score = melhor. Peso igual.

Regras adicionais:
- **Deduplicar classes** da mesma empresa (TAEE3/TAEE4/TAEE11 → mesma raiz de 4 letras): manter a mais líquida.
- **Bancos/seguradoras**: **ranking separado** com métricas próprias (P/VP + P/L) — detalhes abaixo.
- **Rebalanceamento**: mensal por padrão (configurável).

---

## 3. Arquitetura

```
                  ┌────────────── Fase 2: produção (mensal) ──────────────┐
Fundamentus ──┐   │                                                        │
Yahoo/brapi  ─┼──▶│ rank.ts → ranking.csv → site (Pages) + aviso (Telegram) │
              │   └────────────────────────────────────────────────────────┘
CVM DFP/ITR ──┤   ┌────────────── Fase 3: backtest (sob demanda) ─────────┐
B3 COTAHIST ──┴──▶│ backtest.ts → métricas + gráficos → relatório (Pages)  │
                  └────────────────────────────────────────────────────────┘
```

**Princípio central:** `strategy.ts` exporta uma **função pura** `selectPortfolio(snapshot, config)` que recebe os dados de *uma data* e devolve `{ geral: Stock[], financeiros: Stock[] }`. Ela não sabe de onde vieram os dados → a mesma função é usada ao vivo e no backtest.

### Tratamento de bancos e seguradoras

EV/EBIT não se aplica a financeiras (dívida é matéria-prima, não financiamento). A solução é um **ranking paralelo** com métricas adequadas:

| | Universo geral | Financeiras (bancos/seguros) |
|---|---|---|
| Detecção | setor Fundamentus não contém "Banco", "Seguro", "Financ" | setor contém qualquer um desses termos |
| Métricas de valor | EV/EBIT + P/L | **P/VP + P/L** |
| Filtros | liquidez, P/L > 0, PL > 0, vol | liquidez, P/L > 0, PL > 0, vol |
| Top N | `nAcoes = 20` | `nAcoesFin = 5` |
| ROE (opcional) | — | pode entrar como 3ª métrica de qualidade |

`selectPortfolio` separa os dois grupos antes de aplicar os filtros, processa cada um com sua `Config` própria, e retorna ambos. Site e Telegram exibem as duas listas.

---

## 4. Stack Node/TypeScript

| Necessidade | Escolha | Observação |
|---|---|---|
| Runtime | Node 22 LTS, ESM | `"type": "module"` |
| Execução TS | `tsx` | sem build step para scripts |
| Gerenciador | `pnpm` | |
| HTTP | `fetch` nativo | com `User-Agent` de navegador, retry + backoff |
| Parse HTML (Fundamentus) | `cheerio` | página em **ISO-8859-1** → decodificar com `new TextDecoder('latin1')` |
| Números BR | helper próprio `parseBR()` | remover `.` de milhar, `,`→`.`, `%`, tratar `-`/vazio como `null` |
| Preços ao vivo | `yahoo-finance2` (`chart()`), tickers `XXXX4.SA` | fallback: **brapi.dev** via fetch (token em secret) |
| Validação de schema | `zod` | falhar alto se colunas do Fundamentus mudarem |
| Estatística | `simple-statistics` | desvio-padrão, quantis |
| CSV | `csv-parse` / `csv-stringify` | arquivos CVM: `;` e latin1 |
| ZIP (CVM/COTAHIST) | `yauzl` ou `adm-zip` | |
| Armazenamento backtest | `@duckdb/node-api` (opcional) | consultar CSVs grandes da CVM com SQL; se complicar, JSON/arrays em memória |
| Relatório HTML | template string + **Chart.js via CDN** | HTML estático em `docs/` |
| Testes | `vitest` | |
| Lint/format | `biome` | substitui eslint + prettier; mais rápido |
| Notificação | Telegram Bot API via `fetch` | `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` |

Sem framework de dataframe: arrays tipados + helpers pequenos (`groupBy`, `rankBy`, `quantile`).

---

## 5. Estrutura do repositório

```
quant-b3/
├── .github/workflows/
│   ├── ranking.yml          # cron mensal + workflow_dispatch
│   └── backtest.yml         # só workflow_dispatch
├── src/
│   ├── config.ts            # parâmetros (liquidez, nAcoes, corteVol, métricas)
│   ├── types.ts             # Snapshot, Stock, Portfolio...
│   ├── utils/               # parseBR, rank, quantile, retry, dates
│   ├── sources/
│   │   ├── fundamentus.ts   # scraping resultado.php
│   │   ├── prices.ts        # yahoo-finance2 + fallback brapi
│   │   ├── cvm.ts           # download/parse DFP/ITR (fase 3)
│   │   └── cotahist.ts      # parser largura fixa B3 (fase 3)
│   ├── strategy.ts          # ★ selectPortfolio — função pura
│   ├── rank.ts              # entrypoint fase 2
│   ├── diff.ts              # entradas/saídas vs mês anterior
│   ├── report/
│   │   ├── ranking-html.ts
│   │   └── backtest-html.ts
│   ├── notify.ts            # Telegram
│   └── backtest/
│       ├── snapshot.ts      # monta snapshot point-in-time
│       ├── engine.ts        # simulação
│       └── metrics.ts       # CAGR, Sharpe, drawdown...
├── data/
│   ├── rankings/AAAA-MM.csv # histórico versionado
│   └── cache/               # gitignored (CVM, COTAHIST)
├── docs/                    # saída do GitHub Pages
├── tests/
│   └── fixtures/            # HTML salvo do Fundamentus para testes offline
├── package.json
├── tsconfig.json
├── biome.json
└── CLAUDE.md                # convenções para IA assistente
```

Scripts no `package.json`: `rank`, `backtest`, `scan`, `notify`, `test`, `lint`, `typecheck`.

---

## 6. Fase 2 — ranking em produção

### Pipeline (`pnpm rank`)

| Etapa | Detalhe |
|---|---|
| 0. Idempotência | se `data/rankings/AAAA-MM.csv` já existe, sair com código 0 (o cron pode disparar mais de uma vez) |
| 1. Coleta | `https://www.fundamentus.com.br/resultado.php` → cheerio → zod |
| 2. Pré-filtro | liquidez ≥ 1M, P/L > 0, PL > 0, excluir bancos **antes** de buscar preços (~990 → ~120 tickers) |
| 3. Volatilidade | 12 meses de preços diários, concorrência limitada (5 simultâneos) + retry |
| 4. Estratégia | `selectPortfolio()` |
| 5. Diff | comparar com o último CSV → entradas/saídas |
| 6. Persistir | gravar CSV + `docs/index.html` |
| 7. Notificar | Telegram: top N, entradas, saídas, link da página |

### `ranking.yml` (esboço)

```yaml
name: ranking
on:
  schedule: [{ cron: "0 12 1-3 * 1-5" }]   # 9h BRT, primeiros dias úteis
  workflow_dispatch:
permissions: { contents: write, pages: write, id-token: write }
concurrency: { group: ranking, cancel-in-progress: false }
jobs:
  rank:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm rank
        env: { BRAPI_TOKEN: "${{ secrets.BRAPI_TOKEN }}" }
      - run: |
          git config user.name "ranking-bot"
          git config user.email "ranking-bot@users.noreply.github.com"
          git add data/rankings docs
          git commit -m "ranking $(date +%Y-%m)" || exit 0
          git push
      - uses: actions/upload-pages-artifact@v3
        with: { path: docs }
      - uses: actions/deploy-pages@v4
      - run: pnpm notify
        env:
          TELEGRAM_TOKEN: ${{ secrets.TELEGRAM_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
```

### Riscos

| Risco | Mitigação |
|---|---|
| Fundamentus/Yahoo bloqueiam IPs do GitHub | User-Agent, retry com backoff, fallback brapi; se tudo falhar, job falha (GitHub avisa por e-mail) |
| Layout do Fundamentus muda | validação zod; teste com fixture HTML salva em `tests/fixtures/` |
| Pages em repo privado exige plano pago | repo público (decisão 1) |
| Cron desativa após 60 dias sem commits | o commit mensal do bot mantém ativo |

---

## 7. Fase 3 — backtest

### Perguntas a responder
1. A estratégia bateu **Ibovespa** e **SMLL** (≈2012–2026)?
2. Melhor configuração: **20/25/30** ações; rebalanceamento **mensal/trimestral/anual**; corte de vol **0/25/50%**; métrica **EV/EBIT vs composta**.
3. **Pior drawdown** e maior período abaixo do índice.

### Dados

| Necessidade | Fonte | Cuidado |
|---|---|---|
| Balanços | **CVM dados abertos** — DFP (anual) e ITR (trimestral), CSV `;` latin1 por ano | montar **LTM** (soma 4 trimestres); extrair EBIT/lucro/PL/dívida pelo plano de contas |
| Data de publicação | campo de data de recebimento nos arquivos da CVM | **look-ahead bias**: só usar balanço publicado *antes* da data simulada |
| Nº de ações | composição do capital (ITR/DFP) | para valor de mercado e EV históricos |
| Preços | **B3 COTAHIST** (arquivo oficial, largura fixa, inclui deslistadas) | **não ajustado** por proventos/desdobramentos → implementar ajuste |
| CNPJ → ticker | cadastro CVM + lista B3 | tabela de mapeamento manual para casos antigos |
| Benchmarks | Ibovespa, SMLL, CDI | CDI para Sharpe |

⚠️ **Viés de sobrevivência**: usar só Yahoo ignora empresas que quebraram/saíram da bolsa → resultado inflado. COTAHIST é a fonte principal.

### Simulação

```
para cada data de rebalanceamento t:
  fundamentos = último balanço com dataPublicacao < t
  precos      = COTAHIST até t
  snapshot    = montarSnapshot(fundamentos, precos, t)
  carteira    = selectPortfolio(snapshot, cfg)   // mesma função da fase 2
  retorno     = retorno t → t+1 (com proventos)
  custos      = turnover × (corretagem + spread estimado)
```

### Métricas
CAGR vs Ibovespa/SMLL, volatilidade, **Sharpe vs CDI**, **max drawdown** e tempo de recuperação, turnover anual, retorno ano a ano.

### Anti-overfitting
- **In-sample** 2012–2020 para escolher parâmetros; **out-of-sample** 2021–2026 para confirmar.
- Preferir parâmetros robustos (vizinhos também bons) ao melhor ponto isolado.

### `backtest.yml`
Só `workflow_dispatch` com inputs (período, grid). `actions/cache` para `data/cache/` (CVM/COTAHIST). Publica relatório em `docs/backtest/`.

---

## 8. Marcos

| # | Entrega | Pronto quando |
|---|---|---|
| **M1** | Setup + `parseBR` + coletor Fundamentus + `strategy.ts` com testes | `pnpm rank` gera ranking local (vol ainda mockada) |
| **M2** | Volatilidade (yahoo-finance2 + fallback) + dedupe + diff | CSV com top N e entradas/saídas |
| **M3** | `ranking.yml` + commit automático + Telegram | mensagem chega ao clicar "Run workflow" |
| **M4** | GitHub Pages | página com top N e histórico |
| **M5** | Ingestão CVM + COTAHIST com cache | snapshot de qualquer data passada |
| **M6** | Motor de backtest + métricas | curva de 1 config vs Ibovespa |
| **M7** | Grid + relatório in/out-of-sample | página de backtest publicada |
| **M8** | Ajustar `config.ts` com base no backtest | ranking mensal usa parâmetros validados | ✓ |
| **M9** | `pnpm scan` — candidatos pós circuit-breaker | top-20 por janela (30/60/90d) publicado em `docs/scan/` | ✓ |
| **M10** | Calculadora de posição integrada (rank + scan) | B2/T1/T2/Stop/Qtd calculados no browser via σ anual | ✓ |
| **M11** | Critérios de alerta (knife score) — ITR/CVM | 7 critérios (a–g): mom, 52w min, juros↑, lucro não-recorrente, queda tri, dívida sobe, ITR atrasado | ✓ |

---

## 10. Melhorias planejadas (próximas sessões)

### M12 — Ajuste de preços por proventos/desdobramentos (COTAHIST)
- COTAHIST não ajusta preços por dividendos/splits → retornos no scan podem estar distorcidos quando ex-div cai dentro da janela de 30/60/90d
- Implementar fator de ajuste usando o campo `FATOR_AJUSTE` do COTAHIST ou evento de desdobramento do registro tipo 5
- Validar: comparar série VALE3/PETR4 contra Yahoo Finance; logar divergências > 5%

### M13 — Tracker do experimento pessoal
- Página `/docs/experimento/index.html` para acompanhar a carteira pessoal (5 ações, R$3.500, 90d)
- Campos: ticker, data entrada, preço entrada, qtd, alvo 1, alvo 2, stop
- Retorno acumulado vs BOVA11 e CDI (referência local, sem servidor)
- Pode usar `localStorage` para persistir os dados no browser ou um CSV em `data/`

### M14 — GitHub Actions: `scan.yml`
- Workflow para rodar `pnpm scan` semanalmente (ou via `workflow_dispatch`)
- Cache `data/cache/` entre runs (COTAHIST pesa ~2 GB/ano)
- Notificação Telegram com candidatos do dia
- Publicar `docs/scan/` via Pages

### M15 — Re-executar backtest
- `docs/backtest/index.html` está desatualizado: não tem barra de nav, rótulos sem "mom=10%"
- Rodar `pnpm backtest --grid` via GitHub Actions ou localmente
- Comparar resultados antes/depois do filtro de momentum

### M16 — Histórico de scan (últimos 6 meses)
- Salvar cada run de `pnpm scan` como `data/scan/AAAA-MM-DD.json`
- Página de scan exibir quais tickers aparecem consistentemente em múltiplas datas (sinal mais forte)

---

## 11. Arquitetura atual (pós-M11)

### Novos arquivos desde M8

| Arquivo | Função |
|---|---|
| `src/sources/itr.ts` | Download/parse CVM ITR Q1–Q3; `loadItr(ano, cacheDir)` → `Map<cnpj14, ItrTrimestre>` |
| `src/scan-knife.ts` | 7 critérios de alerta; `buildKnifMap(candidates, priceToday, low52w, mom12mMap, itrMap, cnpjByCodigo4, dateToday)` |
| `src/report/nav.ts` | Barra de nav compartilhada; `navHtml(active, dates)`, `NAV_CSS`, `htmlMtime()` |
| `src/build.ts` | `pnpm build`: HTML offline de `data/rankings/*.csv` sem rede |

### Calculadora de posição (M10)

Fórmulas por σ anual:
- σ₃₀d = σ × 0.29; σ₉₀d = σ × 0.50
- **B2** = P × (1 − 0.5 × σ₃₀d) &nbsp;— segundo ponto de entrada
- **T1** = P × (1 + 0.5 × σ₉₀d) &nbsp;— alvo parcial
- **T2** = P × (1 + σ₉₀d) &nbsp;— alvo total
- **Stop** = P × (1 − 0.5 × σ₉₀d)
- **Qtd B1** = ⌊(alloc/2) / preço⌋; **Qtd B2** = ⌊(alloc/2) / B2⌋

Implementado como JS embutido em HTML gerado (sem build step no browser).

### Knife score (M11)

| Critério | Condição | Flag |
|---|---|---|
| a | mom12m no decil inferior | `momBaixo` |
| b | preço ≤ 5% acima da mínima de 52 semanas | `nearMin52w` |
| c | juros↑: conversao < 0.4 AND divLiqPatrim > 0.5 AND P/L ≤ 50 | `jurosAlerta` |
| d | DY > 20% OR P/L > 50 (lucro não-recorrente) | `lucroNaoRecorrente` |
| e | lucroLiqTri < 0 OU < lucroLiqTriAA (via ITR) | `lucroQuedaTri` |
| f | dividaLiq subiu > 20% q/q OU caixa→dívida | `dividaSubiu` |
| g | ITR mais velho que 120 dias | `itrAtrasado` |

Escala: 0–1 🟢, 2–3 🟡, 4+ 🔴

---

## 9. Checklist M1 — concluído ✓

> `pnpm typecheck && pnpm test && pnpm lint` passam. 30 testes. Ranking local gera CSV com vol mockada (0.3).

- [x] `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `.env.example`, `pnpm-workspace.yaml`
- [x] `src/types.ts` — `RawStock`, `Stock`, `Config`, `SelectResult`
- [x] `src/config.ts` — `DEFAULT_CONFIG` + `isFinanceira()`
- [x] `src/utils/parseBR.ts` + testes
- [x] `src/utils/rank.ts` (`rankBy`, `scoreByRanks` índice-based) + testes
- [x] `src/utils/quantile.ts` + `src/utils/retry.ts`
- [x] `src/sources/fundamentus.ts` — fetch + cheerio + zod; `minRows` configurável
- [x] `tests/fixtures/fundamentus.html` — fixture offline
- [x] `tests/fundamentus.test.ts` — 7 testes (parse, financeiras, dedupe, erro)
- [x] `src/strategy.ts` — `selectPortfolio` pura + `enriquecerComVolMock`
- [x] `tests/strategy.test.ts` — 11 testes (filtros, dedupe, separação de grupos)
- [x] `src/rank.ts` — pipeline com idempotência, vol mockada, grava CSV com coluna `grupo`

---

## 9b. Checklist M2 — volatilidade real (próxima sessão)

> Objetivo: substituir vol mockada por volatilidade calculada com preços reais; adicionar diff (entradas/saídas vs mês anterior).

- [ ] `src/sources/prices.ts` — `fetchVolatilidade(ticker, meses=12): Promise<number | null>`
  - `yahoo-finance2`: `chart(ticker + '.SA', { period1, interval: '1d' })`
  - calcular log-retornos diários → desvio-padrão × √252
  - fallback brapi: `GET /quote/{ticker}?token=` + campo `historicalDataPrice`
  - concorrência limitada: processar em lotes de 5 com `Promise.all`
  - `retry` com 3 tentativas + backoff
- [ ] `src/sources/prices.ts` — testes: mock de resposta yahoo; verificar cálculo com série conhecida
- [ ] `src/strategy.ts` — remover `enriquecerComVolMock`; criar `enriquecerComVol(acoes, fetchVol)` assíncrono
- [ ] `src/rank.ts` — usar `enriquecerComVol` em vez de mock; logar tickers sem preço (vol = null → excluir)
- [ ] `src/diff.ts` — `calcDiff(anterior: string[], atual: string[]): { entradas, saidas }`
  - ler último CSV de `data/rankings/` por data
  - comparar tickers do grupo `geral` e `financeiro` separadamente
- [ ] `src/rank.ts` — incluir diff no log e gravar campo `novo`/`saiu` no CSV
- [ ] Testes de integração leves (mock fetch): pipeline completo gera CSV com vol real e diff correto
- [ ] Verificar: `pnpm typecheck && pnpm test && pnpm lint` passam; `pnpm rank` gera CSV com vol real

---

## 9c. Checklist M3 — GitHub Actions + Telegram (foco atual)

> Objetivo: clicar "Run workflow" no GitHub → pipeline roda → mensagem chega no Telegram com top 20 geral + top 5 financeiras.
> Vol ainda mockada (0.3). M2 vem depois.

### src/notify.ts
- [ ] `buildMensagem(result: SelectResult, mes: string, diff: {entradas, saidas}, pageUrl: string): string`
  - cabeçalho: `Ranking B3 — MMM/AAAA`
  - seção Geral: top 20 com posição, ticker, score
  - seção Financeiras: top 5 com posição, ticker, score
  - seção Mudanças: entradas ↑ e saídas ↓ (se houver)
  - rodapé: link da página (Pages — colocar URL quando disponível)
- [ ] `sendTelegram(token, chatId, text)` — POST `https://api.telegram.org/bot{token}/sendMessage`; `parse_mode: HTML`
- [ ] `pnpm notify` lê o CSV mais recente de `data/rankings/`, monta e envia

### .github/workflows/ranking.yml
- [ ] Criar `.github/workflows/ranking.yml` conforme esboço da seção 6
- [ ] Verificar permissões: `contents: write`, `pages: write`, `id-token: write`
- [ ] Secrets necessários: `BRAPI_TOKEN`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`
  - documentar em README ou CLAUDE.md como configurar no repo
- [ ] Step de commit deve usar `|| exit 0` para não falhar quando não há mudanças

### Validação
- [ ] Fazer push para o GitHub
- [ ] Configurar os 3 secrets no repo (Settings → Secrets → Actions)
- [ ] Disparar manualmente via "Run workflow"
- [ ] Confirmar: CSV commitado em `data/rankings/`, mensagem recebida no Telegram

---

## 10. Convenções

- TypeScript `strict`, ESM, funções puras onde possível; I/O isolado em `sources/`.
- Nada de segredos no código; tudo via `secrets` do GitHub / `.env` local (gitignored).
- Datas em `America/Sao_Paulo`; valores monetários em BRL.
- Commits pequenos e descritivos (Conventional Commits).
- Isto é ferramenta pessoal de estudo, **não recomendação de investimento**.
