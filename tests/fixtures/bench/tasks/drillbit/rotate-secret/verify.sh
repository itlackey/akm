#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f commands.txt ]]; then echo "commands.txt missing"; exit 1; fi

if ! grep -qE 'drillbit secret rotate' commands.txt; then
  echo "missing 'drillbit secret rotate'"; exit 1
fi
if ! grep -qE 'services/auth/token' commands.txt; then
  echo "missing secret path services/auth/token"; exit 1
fi
if ! grep -qE -- '--algorithm[[:space:]]+ed25519' commands.txt; then
  echo "missing '--algorithm ed25519'"; exit 1
fi

echo "ok"
