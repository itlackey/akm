#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then echo "commands.txt missing"; exit 1; fi

if ! grep -qE 'drillbit scale' commands.txt; then
  echo "missing 'drillbit scale'"; exit 1
fi
if ! grep -qE 'dev-edge' commands.txt; then
  echo "missing cluster name dev-edge"; exit 1
fi
if ! grep -qE -- '--replicas[[:space:]]+4' commands.txt; then
  echo "missing '--replicas 4'"; exit 1
fi

echo "ok"
