#!/usr/bin/env bash
# Deterministic verifier for repeated-fail-storage-lifecycle-b.
#
# Companion to variant A. Same gold ref, same coverage gap. See variant
# A's verifier and task.yaml for the rationale on why repeated failure
# here is the intended training signal.
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

if ! grep -qE 'daysAfterLastAccessTimeGreaterThan' commands.txt; then
  echo "commands.txt missing last-access action key"
  exit 1
fi

if ! grep -qE 'tierToCool' commands.txt; then
  echo "commands.txt missing tierToCool action"
  exit 1
fi

echo "ok"
exit 0
