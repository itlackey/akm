#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az storage account create' commands.txt; then
  echo "commands.txt missing 'az storage account create'"
  exit 1
fi

if ! grep -qE '(-n|--name)[[:space:]]+mystorage' commands.txt; then
  echo "commands.txt missing storage account name mystorage"
  exit 1
fi

if ! grep -qE '\-\-sku[[:space:]]+Standard_LRS' commands.txt; then
  echo "commands.txt missing --sku Standard_LRS"
  exit 1
fi

if ! grep -qE '(-g|--resource-group)[[:space:]]+myrg' commands.txt; then
  echo "commands.txt missing resource group myrg"
  exit 1
fi

echo "ok"
exit 0
