# CLAUDE.md — quant-b3

Leia o `plan.md` completo antes de qualquer ação. Este arquivo é um resumo rápido das convenções.

## Stack

- Node 22 LTS + TypeScript strict, ESM (`"type": "module"`)
- `pnpm` como gerenciador de pacotes
- `tsx` para executar scripts TS sem build
- `biome` para lint e format (não eslint/prettier)
- `vitest` para testes

## Scripts

```
pnpm rank        # gera ranking do mês
pnpm backtest    # roda backtest (sob demanda)
pnpm scan        # candidatos à recuperação pós circuit-breaker (30/60/90d)
pnpm notify      # envia notificação Telegram
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
```

Ao fim de cada marco: `pnpm typecheck && pnpm test && pnpm lint`.

## Decisões fixas

- Repo **público**
- Notificação: **Telegram** (`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` via secrets/`.env`)
- Bancos/seguradoras: **ranking separado** — métricas P/VP + P/L (EV/EBIT não se aplica a financeiras)
- Parâmetros iniciais — geral: **20 ações**, **EV/EBIT + P/L**; financeiras: **5 ações**, **P/VP + P/L**; rebalanceamento **mensal**
- Filtro de momentum **ativo** (`corteMomento = 0.10`): descarta o decil inferior do retorno 12-1m para evitar "facas caindo". Ações sem dados passam. Parâmetro do backtest grid para validação.
- Executar **M1–M4** antes do backtest (M5–M8)

## Bancos e seguradoras

Detectar pelo campo `setor` do Fundamentus: `setor.includes('Banco') || setor.includes('Seguro') || setor.includes('Financ')`.

`selectPortfolio` retorna `SelectResult = { geral: Stock[], financeiros: Stock[] }`. Cada grupo tem sua própria `Config` (métricas, top N). Filtros de liquidez e volatilidade são iguais para ambos.

## Convenções de código

- Funções puras em `strategy.ts`; todo I/O em `sources/`
- `parseBR(s)` para números brasileiros (separador milhar `.`, decimal `,`, `%`, `-`/vazio → `null`)
- Tickers Yahoo: sufixo `.SA` (ex.: `PETR4.SA`)
- Encoding Fundamentus: ISO-8859-1 → `new TextDecoder('latin1')`
- Datas em `America/Sao_Paulo`; BRL para valores monetários
- Sem segredos no código — `.env` local (gitignored) e `secrets` no GitHub Actions
- Conventional Commits (`feat:`, `fix:`, `chore:`, etc.)

## Segredos necessários

```
BRAPI_TOKEN       # brapi.dev (fallback de preços)
TELEGRAM_TOKEN    # bot do Telegram
TELEGRAM_CHAT_ID  # chat de destino
```

## Estrutura principal

```
src/
  config.ts          # DEFAULT_CONFIG: liquidezMin, nAcoes, corteVol, corteMomento, metricas
  types.ts           # RawStock, Stock, Snapshot, Portfolio, Config
  utils/             # parseBR, rankBy, quantile, retry
  sources/           # fundamentus, prices, cvm, cotahist  (I/O aqui)
  strategy.ts        # selectPortfolio(snapshot, config) — função pura
  rank.ts            # entrypoint pnpm rank
  diff.ts            # entradas/saídas vs mês anterior
  scan.ts            # entrypoint pnpm scan (pós circuit-breaker)
  report/            # ranking-html, backtest-html, scan-html
  notify.ts          # Telegram
  backtest/          # snapshot, engine, metrics
data/
  rankings/          # AAAA-MM.csv (versionado)
  cache/             # gitignored (CVM, COTAHIST)
docs/                # GitHub Pages (gerado)
tests/
  fixtures/          # HTML salvo do Fundamentus para testes offline
```

## Marco atual: M8/M9 completos

M1–M7 concluídos. M8 (calibrar config com backtest) e M9 (scan pós-CB) implementados.
Próximo passo: rodar `pnpm backtest --grid` no CI para validar impacto do filtro de momentum.
