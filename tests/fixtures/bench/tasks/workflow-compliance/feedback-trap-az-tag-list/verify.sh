#!/usr/bin/env bash
# Deterministic verifier for feedback-trap-az-tag-list.
#
# This task is intentionally hard to satisfy from the gold ref alone
# (`skill:az-cli` describes `--query` and `-o tsv` but not the compound
# tag-selector pattern). The verifier checks for the structural shape of
# the correct command; tasks that only echo the asset's hints will not
# match all four greps.
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az resource list' commands.txt; then
  echo "commands.txt missing 'az resource list'"
  exit 1
fi

# Compound tag selector: both env=prod AND tier=data must appear as
# --tag arguments (order-independent).
if ! grep -qE -- '--tag[[:space:]]+env=prod' commands.txt; then
  echo "commands.txt missing tag selector for env=prod"
  exit 1
fi

if ! grep -qE -- '--tag[[:space:]]+tier=data' commands.txt; then
  echo "commands.txt missing tag selector for tier=data"
  exit 1
fi

# JMESPath projection — must reference all three column identifiers.
if ! grep -qE -- '--query[[:space:]]+["'\''].*name.*type.*location.*["'\'']' commands.txt; then
  echo "commands.txt missing JMESPath projection over name/type/location"
  exit 1
fi

if ! grep -qE -- '-o[[:space:]]+tsv' commands.txt; then
  echo "commands.txt missing tsv output flag"
  exit 1
fi

echo "ok"
exit 0
