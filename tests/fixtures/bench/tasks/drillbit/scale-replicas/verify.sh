#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then echo "commands.txt missing"; exit 1; fi

if ! grep -qE 'drillbit scale' commands.txt; then
  echo "missing 'drillbit scale'"; exit 1
fi
if ! grep -qE 'prod-core' commands.txt; then
  echo "missing cluster name prod-core"; exit 1
fi
if ! grep -qE -- '--replicas[[:space:]]+8' commands.txt; then
  echo "missing '--replicas 8'"; exit 1
fi

echo "ok"
