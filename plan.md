# PLAN.md — quant-b3: ranking quantitativo de ações da B3

> Documento de handoff. Leia inteiro antes de começar. Responda sempre em **português do Brasil**, de forma concisa e técnica.
> **Antes de escrever código, confirme comigo as "Decisões em aberto" (seção 9).** Depois, comece pelo **M1**.

---

## 1. Contexto

Sou dev e invisto na B3. Quero automatizar uma estratégia quantitativa de valor (sugerida pelo canal *Clube do Valor*) **sem manter servidor**: tudo roda em **GitHub Actions**, publica em **GitHub Pages** e notifica via **Telegram**. Além disso, quero um **backtest** histórico para validar e calibrar os parâmetros antes de confiar no ranking.

Stack: **Node.js 22 + TypeScript** (nada de Python).

## 2. A estratégia (4 passos)

1. **Universo barato e líquido**: todas as ações da B3, filtradas por liquidez média diária (2 meses) ≥ R$ 1.000.000.
2. **Tirar prejuízo**: lucro líquido 12m > 0 (P/L > 0) e patrimônio líquido > 0.
3. **Tirar as mais voláteis**: calcular a volatilidade anualizada de 12 meses (desvio-padrão dos log-retornos diários × √252) e descartar o quartil superior (`corteVol = 0.25`, configurável).
4. **Ranquear por índice de valor e comprar as 20–30 primeiras**: score = soma dos ranks das métricas de valor (padrão: EV/EBIT + P/L; P/VP opcional); menor score = melhor. Peso igual.

Regras adicionais:
- **Deduplicar classes** da mesma empresa (TAEE3/TAEE4/TAEE11 → mesma raiz de 4 letras): manter a mais líquida.
- **Bancos/seguradoras não têm EV/EBIT** no Fundamentus → tratamento conforme decisão da seção 9.
- **Rebalanceamento**: mensal por padrão (configurável).

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

**Princípio central:** `strategy.ts` exporta uma **função pura** `selectPortfolio(snapshot, config)` que recebe os dados de *uma data* e devolve o top N. Ela não sabe de onde vieram os dados → a mesma função é usada ao vivo e no backtest.

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
| Lint/format | `eslint` + `prettier` (ou `biome`) | |
| Notificação | Telegram Bot API via `fetch` | `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` |

Sem framework de dataframe: arrays tipados + helpers pequenos (`groupBy`, `rankBy`, `quantile`).

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
├── package.json
└── tsconfig.json
```

Scripts no `package.json`: `rank`, `backtest`, `notify`, `test`, `lint`, `typecheck`.

## 6. Fase 2 — ranking em produção

### Pipeline (`pnpm rank`)

| Etapa | Detalhe |
|---|---|
| 0. Idempotência | se `data/rankings/AAAA-MM.csv` já existe, sair com código 0 (o cron pode disparar mais de uma vez) |
| 1. Coleta | `https://www.fundamentus.com.br/resultado.php` → cheerio → zod |
| 2. Pré-filtro | liquidez, P/L > 0, PL > 0 **antes** de buscar preços (~990 → ~150 tickers) |
| 3. Volatilidade | 12 meses de preços diários para os pré-filtrados, com concorrência limitada (ex.: 5) e retry |
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
| Pages em repo privado exige plano pago | decidir público/privado (seção 9) |
| Cron desativa após 60 dias sem commits | o commit mensal do bot mantém ativo |

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

## 8. Marcos

| # | Entrega | Pronto quando |
|---|---|---|
| **M1** | Setup do repo (pnpm, TS, vitest, lint) + `parseBR` + coletor Fundamentus + `strategy.ts` com testes | `pnpm rank` gera ranking local (vol ainda mockada) |
| **M2** | Volatilidade (yahoo-finance2 + fallback) + dedupe + diff | CSV com top N e entradas/saídas |
| **M3** | `ranking.yml` + commit + Telegram | mensagem chega ao clicar "Run workflow" |
| **M4** | GitHub Pages | página com top N e histórico |
| **M5** | Ingestão CVM + COTAHIST com cache | snapshot de qualquer data passada |
| **M6** | Motor de backtest + métricas | curva de 1 config vs Ibovespa |
| **M7** | Grid + relatório in/out-of-sample | página de backtest publicada |
| **M8** | Ajustar `config.ts` com base no backtest | ranking mensal usa parâmetros validados |

Trabalhe um marco por vez; ao fim de cada um, rode `pnpm typecheck && pnpm test && pnpm lint` e me mostre um resumo curto.

## 9. Decisões em aberto (perguntar antes de começar)

1. Repositório **público ou privado**? (define uso do Pages grátis)
2. Notificação: **Telegram**, e-mail ou só página?
3. **Bancos**: ranking próprio (P/L + P/VP) ou excluir?
4. Ordem: **M1–M4 primeiro** ou **backtest primeiro**?
5. Parâmetros iniciais: nº de ações (20/25/30), métricas de valor, frequência.

## 10. Convenções

- TypeScript `strict`, ESM, funções puras onde possível; I/O isolado em `sources/`.
- Nada de segredos no código; tudo via `secrets` do GitHub / `.env` local (gitignored).
- Datas em `America/Sao_Paulo`; valores monetários em BRL.
- Commits pequenos e descritivos (Conventional Commits).
- Isto é ferramenta pessoal de estudo, **não recomendação de investimento**.