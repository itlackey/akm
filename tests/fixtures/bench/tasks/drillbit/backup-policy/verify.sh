#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then echo "commands.txt missing"; exit 1; fi

if ! grep -qE 'drillbit backup' commands.txt; then
  echo "missing 'drillbit backup'"; exit 1
fi
if ! grep -qE 'vault-primary' commands.txt; then
  echo "missing cluster name vault-primary"; exit 1
fi
if ! grep -qE -- '--retention[[:space:]]+90d' commands.txt; then
  echo "missing '--retention 90d'"; exit 1
fi
if ! grep -qE -- '--snapshots[[:space:]]+7' commands.txt; then
  echo "missing '--snapshots 7'"; exit 1
fi

echo "ok"
