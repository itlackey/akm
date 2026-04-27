#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f opencode.json ]]; then
  echo "opencode.json missing"
  exit 1
fi

if jq -e '(.tools | sort) == ["bash","edit","read"]' opencode.json >/dev/null; then
  echo "ok"
  exit 0
fi

echo "opencode.json tools did not equal [bash, edit, read]"
exit 1
