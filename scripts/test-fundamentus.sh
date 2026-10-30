#!/usr/bin/env bash
# Testa se o Fundamentus responde via GET vs POST
set -euo pipefail

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
URL="https://www.fundamentus.com.br/resultado.php"

echo "=== GET (sem parâmetros) ==="
ROWS_GET=$(curl -s --compressed -H "User-Agent: $UA" "$URL" | grep -c '<tr>' || true)
echo "  <tr> encontrados: $ROWS_GET"

echo ""
echo "=== POST (negociada=ON, sem filtros) ==="
ROWS_POST=$(curl -s --compressed \
  -H "User-Agent: $UA" \
  -H "Referer: https://www.fundamentus.com.br/buscaavancada.php" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "pl_min=&pl_max=&pvp_min=&pvp_max=&psr_min=&psr_max=&divy_min=&divy_max=&pativos_min=&pativos_max=&pcapgiro_min=&pcapgiro_max=&pebit_min=&pebit_max=&fgrah_min=&fgrah_max=&firma_ebit_min=&firma_ebit_max=&firma_ebitda_min=&firma_ebitda_max=&margemebit_min=&margemebit_max=&margemliq_min=&margemliq_max=&liqcorr_min=&liqcorr_max=&roic_min=&roic_max=&roe_min=&roe_max=&liq_min=&liq_max=&patrim_min=&patrim_max=&divbruta_min=&divbruta_max=&tx_cresc_rec_min=&tx_cresc_rec_max=&setor=&negociada=ON&ordem=1&x=28&y=16" \
  "$URL" | grep -c '<tr>' || true)
echo "  <tr> encontrados: $ROWS_POST"

echo ""
echo "=== POST setor=20 (Intermediários Financeiros) ==="
curl -s --compressed \
  -H "User-Agent: $UA" \
  -H "Referer: https://www.fundamentus.com.br/buscaavancada.php" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "setor=20&negociada=ON&ordem=1&x=28&y=16" \
  "$URL" \
  | grep -oP '(?<=papel=)[A-Z0-9]+' | head -20
