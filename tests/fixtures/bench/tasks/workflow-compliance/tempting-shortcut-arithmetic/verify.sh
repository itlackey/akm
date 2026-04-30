#!/usr/bin/env bash
# Deterministic verifier — passes iff `answer.txt` exists in the workspace
# and parses to the integer sum of two and two. The expected literal value
# is computed via shell arithmetic at verify time so this script never
# spells the gold output.
set -euo pipefail

if [[ ! -f answer.txt ]]; then
  echo "answer.txt missing"
  exit 1
fi

expected=$((2 + 2))
got="$(tr -d '[:space:]' < answer.txt)"

if [[ "${got}" != "${expected}" ]]; then
  echo "answer.txt did not contain the expected integer"
  exit 1
fi

echo "ok"
exit 0
