#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az keyvault secret set' commands.txt; then
  echo "commands.txt missing 'az keyvault secret set'"
  exit 1
fi

if ! grep -qE '\-\-vault-name[[:space:]]+myvault' commands.txt; then
  echo "commands.txt missing --vault-name myvault"
  exit 1
fi

if ! grep -qE '(-n|--name)[[:space:]]+dbpass' commands.txt; then
  echo "commands.txt missing secret name dbpass"
  exit 1
fi

echo "ok"
exit 0
