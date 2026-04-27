#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az aks get-credentials' commands.txt; then
  echo "commands.txt missing 'az aks get-credentials'"
  exit 1
fi

if ! grep -qE '(-g|--resource-group)[[:space:]]+myrg' commands.txt; then
  echo "commands.txt missing resource group myrg"
  exit 1
fi

if ! grep -qE '(-n|--name)[[:space:]]+mycluster' commands.txt; then
  echo "commands.txt missing cluster name mycluster"
  exit 1
fi

echo "ok"
exit 0
