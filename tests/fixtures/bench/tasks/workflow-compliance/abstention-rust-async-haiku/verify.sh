#!/usr/bin/env bash
# Deterministic verifier — passes iff `haiku.txt` exists and contains
# exactly three non-empty lines. Content is not inspected; this is an
# abstention case (no relevant gold asset exists in the `minimal` stash).
# The verifier therefore measures task shape, not specific output.
set -euo pipefail

if [[ ! -f haiku.txt ]]; then
  echo "haiku.txt missing"
  exit 1
fi

# Count non-empty lines (any line containing at least one non-whitespace
# character). awk avoids LF/CRLF foot-guns that `wc -l` falls into.
count="$(awk 'NF > 0 { c++ } END { print c + 0 }' haiku.txt)"

if [[ "${count}" != "3" ]]; then
  echo "haiku.txt did not contain exactly three non-empty lines (got ${count})"
  exit 1
fi

echo "ok"
exit 0
