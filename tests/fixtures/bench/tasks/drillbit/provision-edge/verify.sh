#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then echo "commands.txt missing"; exit 1; fi

if ! grep -qE 'drillbit provision' commands.txt; then
  echo "missing 'drillbit provision'"; exit 1
fi
if ! grep -qE 'sentinel-1' commands.txt; then
  echo "missing cluster name sentinel-1"; exit 1
fi
if ! grep -qE -- '--tier[[:space:]]+edge' commands.txt; then
  echo "missing '--tier edge'"; exit 1
fi
if ! grep -qE -- '--region[[:space:]]+az-west' commands.txt; then
  echo "missing '--region az-west'"; exit 1
fi
if ! grep -qE -- '--replicas[[:space:]]+3' commands.txt; then
  echo "missing '--replicas 3'"; exit 1
fi

echo "ok"
