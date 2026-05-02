#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then echo "commands.txt missing"; exit 1; fi

if ! grep -qE 'drillbit canary enable' commands.txt; then
  echo "missing 'drillbit canary enable'"; exit 1
fi
if ! grep -qE 'staging-west' commands.txt; then
  echo "missing cluster name staging-west"; exit 1
fi
if ! grep -qE -- '--weight[[:space:]]+20' commands.txt; then
  echo "missing '--weight 20'"; exit 1
fi

echo "ok"
