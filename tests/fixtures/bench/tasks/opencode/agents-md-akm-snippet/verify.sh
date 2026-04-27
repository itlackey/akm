#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f AGENTS.md ]]; then
  echo "AGENTS.md missing"
  exit 1
fi

if grep -q 'akm search' AGENTS.md; then
  echo "ok"
  exit 0
fi

echo "AGENTS.md did not mention 'akm search'"
exit 1
