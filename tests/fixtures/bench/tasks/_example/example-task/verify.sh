#!/usr/bin/env bash
# Example verifier — passes iff `greeting.txt` exists in the workspace and
# contains the word "hello" (case-insensitive).
set -euo pipefail

if [[ ! -f greeting.txt ]]; then
  echo "greeting.txt missing"
  exit 1
fi

if grep -qi "hello" greeting.txt; then
  echo "ok"
  exit 0
fi

echo "greeting.txt did not contain 'hello'"
exit 1
