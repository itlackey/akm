#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then echo "commands.txt missing"; exit 1; fi

if ! grep -qE 'drillbit backup' commands.txt; then
  echo "missing 'drillbit backup'"; exit 1
fi
if ! grep -qE 'logs-archive' commands.txt; then
  echo "missing cluster name logs-archive"; exit 1
fi
if ! grep -qE -- '--retention[[:space:]]+30d' commands.txt; then
  echo "missing '--retention 30d'"; exit 1
fi
if ! grep -qE -- '--snapshots[[:space:]]+14' commands.txt; then
  echo "missing '--snapshots 14'"; exit 1
fi

echo "ok"
