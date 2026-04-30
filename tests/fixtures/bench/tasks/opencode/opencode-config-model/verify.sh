#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f opencode.json ]]; then
  echo "opencode.json missing"
  exit 1
fi

if jq -e '.model == "anthropic/claude-opus-4-7"' opencode.json >/dev/null; then
  echo "ok"
  exit 0
fi

echo "opencode.json did not pin model to anthropic/claude-opus-4-7"
exit 1
