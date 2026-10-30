#!/usr/bin/env bash
# Acompanha logs do GitHub Actions do projeto b3 no terminal.
# Uso: ./scripts/watch-actions.sh [run-id]
set -euo pipefail

REPO="VergilSkye/b3"
WORKFLOW="ranking"

# Cor
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# Resolve o run-id: argumento, ou o mais recente do workflow
if [[ $# -ge 1 ]]; then
  RUN_ID="$1"
else
  echo -e "${CYAN}Buscando último run de '${WORKFLOW}'...${RESET}"
  RUN_ID=$(gh run list \
    --repo "$REPO" \
    --workflow "$WORKFLOW" \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId')
fi

if [[ -z "$RUN_ID" ]]; then
  echo -e "${RED}Nenhum run encontrado.${RESET}"
  exit 1
fi

# Mostra resumo do run
echo ""
gh run view "$RUN_ID" --repo "$REPO"
echo ""

# Verifica status atual
STATUS=$(gh run view "$RUN_ID" --repo "$REPO" --json status --jq '.status')

if [[ "$STATUS" == "in_progress" || "$STATUS" == "queued" || "$STATUS" == "waiting" ]]; then
  echo -e "${YELLOW}▶ Run ${BOLD}${RUN_ID}${RESET}${YELLOW} em andamento — acompanhando ao vivo...${RESET}"
  echo ""
  # Acompanha ao vivo: atualiza a cada 3s até terminar
  gh run watch "$RUN_ID" --repo "$REPO" --exit-status
  EXIT=$?

  echo ""
  if [[ $EXIT -eq 0 ]]; then
    echo -e "${GREEN}✔ Workflow concluído com sucesso.${RESET}"
  else
    echo -e "${RED}✘ Workflow falhou (exit $EXIT). Exibindo logs de erro:${RESET}"
    echo ""
    # Baixa e filtra apenas as linhas de erro
    TMP=$(mktemp -d)
    gh api "repos/${REPO}/actions/runs/${RUN_ID}/logs" > "${TMP}/logs.zip" 2>/dev/null
    unzip -q -o "${TMP}/logs.zip" -d "${TMP}/logs" 2>/dev/null || true
    grep -rh --no-filename \
      -E "(Error|error|ERR_|##\[error\]|falhou|Cobertura|failed|FAIL)" \
      "${TMP}/logs/" \
      | grep -v "##\[debug\]" \
      | grep -v "DeprecationWarning" \
      | head -40
    rm -rf "$TMP"
  fi

else
  # Run já concluído — exibe logs filtrados
  echo -e "${CYAN}Run ${BOLD}${RUN_ID}${RESET}${CYAN} já concluído (${STATUS}). Exibindo logs relevantes:${RESET}"
  echo ""
  TMP=$(mktemp -d)
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/logs" > "${TMP}/logs.zip" 2>/dev/null
  unzip -q -o "${TMP}/logs.zip" -d "${TMP}/logs" 2>/dev/null || true

  # Mostra linhas que não são debug nem warnings de deprecação
  grep -rh --no-filename \
    -E "^2[0-9]{3}-[0-9]{2}-[0-9]{2}T" \
    "${TMP}/logs/" \
    | grep -v "##\[debug\]" \
    | grep -v "DeprecationWarning" \
    | grep -v "Use \`node --trace" \
    | sed 's/^[0-9T:.-]*Z //' \
    | grep -E "(Gerando|Coletando|Calculando|Baixando|Extraindo|Parseando|Cobertura|Geral:|Financeiras:|Ranking salvo|HTML gerado|Enviando|Enviado|Error|error|ERR_|##\[error\]|✓|✘)" \
    | head -60

  rm -rf "$TMP"
fi
