#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-storage-lifecycle-a.
#
# The required command goes well beyond the gold ref's coverage. Most
# arms will fail this check — that is intentional. Repeated failure on
# this task and its companion (variant B) is the trigger condition for
# the reflect/distill workflow.
set -euo pipefail

if [[ ! -f commands.txt ]]; then
  echo "commands.txt missing"
  exit 1
fi

if ! grep -qE 'az storage account management-policy create' commands.txt; then
  echo "commands.txt missing 'az storage account management-policy create'"
  exit 1
fi

if ! grep -qE -- '--account-name[[:space:]]+mystorage' commands.txt; then
  echo "commands.txt missing --account-name mystorage"
  exit 1
fi

if ! grep -qE -- '(-g|--resource-group)[[:space:]]+myrg' commands.txt; then
  echo "commands.txt missing --resource-group myrg"
  exit 1
fi

if ! grep -qE 'blockBlob' commands.txt; then
  echo "commands.txt missing blob-type qualifier"
  exit 1
fi

if ! grep -qE 'daysAfterModificationGreaterThan' commands.txt; then
  echo "commands.txt missing modification-age action key"
  exit 1
fi

echo "ok"
exit 0
