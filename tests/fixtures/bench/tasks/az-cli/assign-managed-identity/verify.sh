#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az vm identity assign' commands.txt; then
  echo "commands.txt missing 'az vm identity assign'"
  exit 1
fi

if ! grep -qE '(-g|--resource-group)[[:space:]]+myrg' commands.txt; then
  echo "commands.txt missing resource group myrg"
  exit 1
fi

if ! grep -qE '(-n|--name)[[:space:]]+myvm' commands.txt; then
  echo "commands.txt missing VM name myvm"
  exit 1
fi

echo "ok"
exit 0
