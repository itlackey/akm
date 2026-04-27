#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az resource list' commands.txt; then
  echo "commands.txt missing 'az resource list'"
  exit 1
fi

if ! grep -qE '\-\-tag[[:space:]]+env=prod' commands.txt; then
  echo "commands.txt missing --tag env=prod"
  exit 1
fi

echo "ok"
exit 0
