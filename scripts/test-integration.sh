#!/usr/bin/env bash
#
# Integration-test runner: shards tests/integration across separate OS
# processes (min(nproc, 8) concurrent `bun test` processes, each on a
# deterministic --shard slice) — same mechanism and rationale as
# scripts/test-unit.sh (see its header for why neither `--isolate` nor
# `--parallel` is ever passed). Serial single-process runs cost ~9.5 min of
# wall clock for ~570s of test time; sharding cuts that to roughly the
# slowest shard.
#
# Per-process isolation here is STRICTLY STRONGER than the previous
# single-process run (files no longer share process.env or module state with
# every sibling), and cross-file isolation is already required by
# scripts/lint-tests-isolation.ts.
#
# Usage:  scripts/test-integration.sh            # auto shards (min(nproc, 8))
#         TEST_SHARDS=4 scripts/test-integration.sh
set -uo pipefail

cores="$(nproc 2>/dev/null || echo 4)"
N="${TEST_SHARDS:-$cores}"
[ "$N" -gt 8 ] && N=8
[ "$N" -lt 1 ] && N=1

bun run sweep:tmp >/dev/null 2>&1 || true

declare -a pids tmps
for k in $(seq 1 "$N"); do
  t="$(mktemp)"
  tmps+=("$t")
  ( bun test --timeout=30000 ./tests/integration --shard="$k/$N" >"$t" 2>&1 ) &
  pids+=($!)
done

# Wait for every shard; a non-zero shard exit fails the run.
rc=0
for p in "${pids[@]}"; do
  wait "$p" || rc=1
done

# Aggregate and surface results.
pass=0 fail=0
for t in "${tmps[@]}"; do
  p="$(grep -oE '[0-9]+ pass' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  f="$(grep -oE '[0-9]+ fail' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  pass=$((pass + ${p:-0}))
  fail=$((fail + ${f:-0}))
  # Surface any real failures from this shard.
  grep -E "\(fail\)|^error:|panic" "$t" | head -10 || true
  rm -f "$t"
done

echo "── integration: ${pass} pass / ${fail} fail across ${N} process-shards"
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ]; then
  exit 1
fi
exit 0
