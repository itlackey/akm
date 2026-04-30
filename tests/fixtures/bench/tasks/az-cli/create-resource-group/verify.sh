#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az group create' commands.txt; then
  echo "commands.txt missing 'az group create'"
  exit 1
fi

if ! grep -qE '(-n|--name)[[:space:]]+myrg' commands.txt; then
  echo "commands.txt missing resource group name myrg"
  exit 1
fi

if ! grep -qE '(-l|--location)[[:space:]]+eastus' commands.txt; then
  echo "commands.txt missing location eastus"
  exit 1
fi

echo "ok"
exit 0
