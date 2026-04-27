#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f provider.sh ]]; then
  echo "provider.sh missing"
  exit 1
fi

if grep -q 'akm feedback' provider.sh; then
  echo "ok"
  exit 0
fi

echo "provider.sh did not invoke akm feedback"
exit 1
