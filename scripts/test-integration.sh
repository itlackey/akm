#!/usr/bin/env bash
#
# Integration-test runner: shards tests/integration across separate OS
# processes (min(nproc, 8) concurrent `bun test` processes), same rationale
# as scripts/test-unit.sh (see its header for why neither `--isolate` nor
# `--parallel` is ever passed). Serial single-process runs cost ~9.5 min of
# wall clock for ~570s of test time; sharding cuts that to roughly the
# slowest shard.
#
# Sharding is done by EXPLICIT round-robin file lists, NOT bun's `--shard`:
# on bun 1.3.x that flag only slices when the positional path is the test
# root (`./tests`, where it slices at the TEST level); with a subdirectory
# positional like `./tests/integration` it is SILENTLY IGNORED and every
# process runs the full suite concurrently — 4x the work plus same-file
# collisions on fixture paths. File-granular lists also guarantee each test
# file runs in exactly one process.
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

# Deterministic file list; sort so every machine shards identically.
mapfile -t files < <(find tests/integration -name '*.test.ts' | sort)
total="${#files[@]}"
if [ "$total" -eq 0 ]; then
  echo "── integration: no test files found under tests/integration" >&2
  exit 1
fi
[ "$N" -gt "$total" ] && N="$total"

declare -a pids tmps
for k in $(seq 0 $((N - 1))); do
  slice=()
  for i in "${!files[@]}"; do
    [ $((i % N)) -eq "$k" ] && slice+=("${files[$i]}")
  done
  t="$(mktemp)"
  tmps+=("$t")
  # 120s per-test (vs 30s serial): under N-way process contention a heavy test
  # can legitimately run 3-4x its solo duration; the timeout exists to catch
  # HANGS, not to police performance, and 30s flaked real passes under load.
  ( bun test --timeout=120000 "${slice[@]}" >"$t" 2>&1 ) &
  pids+=($!)
done

# Wait for every shard; a non-zero shard exit fails the run.
rc=0
for p in "${pids[@]}"; do
  wait "$p" || rc=1
done

# Aggregate and surface results.
pass=0 fail=0 filecount=0
for t in "${tmps[@]}"; do
  p="$(grep -oE '[0-9]+ pass' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  f="$(grep -oE '[0-9]+ fail' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  c="$(grep -oE 'across [0-9]+ files' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  pass=$((pass + ${p:-0}))
  fail=$((fail + ${f:-0}))
  filecount=$((filecount + ${c:-0}))
  # Surface any real failures from this shard — summary lines first, then the
  # full tail so assertion diffs survive aggregation (a flake with no diff is
  # undiagnosable).
  if [ "${f:-0}" != "0" ] || ! grep -qE '[0-9]+ pass' "$t"; then
    grep -E "\(fail\)|^error:|panic" "$t" | head -10 || true
    echo "── shard log tail (last 80 lines) ──"
    tail -80 "$t"
  fi
  rm -f "$t"
done

echo "── integration: ${pass} pass / ${fail} fail across ${N} process-shards (${filecount}/${total} files)"
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ] || [ "$filecount" -ne "$total" ]; then
  exit 1
fi
exit 0
