#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f system.txt ]]; then
  echo "system.txt missing"
  exit 1
fi

if ! grep -qi 'akm feedback' system.txt; then
  echo "system.txt did not mention 'akm feedback'"
  exit 1
fi

if grep -qiE '(positive|negative|±)' system.txt; then
  echo "ok"
  exit 0
fi

echo "system.txt did not mention positive/negative/±"
exit 1
