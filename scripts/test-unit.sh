#!/usr/bin/env bash
#
# Local unit-test runner: fast AND race-free.
#
# WHY THIS EXISTS (the #664 fix). Bun's in-process test parallelism
# (`bun test --parallel=N`, N>1) runs multiple test files as worker threads in
# ONE process that share a single fd table. On Bun 1.3.x --isolate workers this
# intermittently hits an `EEXIST: file already exists, epoll_ctl` race (an fd is
# registered with epoll while a freed fd number is recycled), which aborts the
# run or busy-spins to a hang and then reports "Cannot call afterAll() after the
# test run has completed". The race is in the runtime's fd handling, below the
# app, so it cannot be fixed by cleaning up application state — only by NOT
# sharing an fd table across concurrently-running files.
#
# So we get parallelism from SEPARATE OS PROCESSES instead: N shards, each a
# `bun test --parallel=1` process with its OWN fd table. Cross-process fd tables
# never collide, so the epoll race is structurally impossible — while the N
# processes still run concurrently across cores for speed. This is the same
# isolation model CI uses (one shard per runner job); here we run the shards as
# concurrent processes on one machine.
#
# Usage:  scripts/test-unit.sh            # auto shards (min(nproc, 8))
#         TEST_SHARDS=4 scripts/test-unit.sh
set -uo pipefail

cores="$(nproc 2>/dev/null || echo 4)"
N="${TEST_SHARDS:-$cores}"
[ "$N" -gt 8 ] && N=8
[ "$N" -lt 1 ] && N=1

bun run sweep:tmp >/dev/null 2>&1 || true

paths=(./tests --path-ignore-patterns=tests/integration)
declare -a pids tmps
for k in $(seq 1 "$N"); do
  t="$(mktemp)"
  tmps+=("$t")
  ( bun test --parallel=1 --timeout=30000 "${paths[@]}" --shard="$k/$N" >"$t" 2>&1 ) &
  pids+=($!)
done

# Wait for every shard; a non-zero shard exit fails the run.
rc=0
for p in "${pids[@]}"; do
  wait "$p" || rc=1
done

# Aggregate and surface results. The epoll race string must never appear with
# this runner — if it ever does, fail loudly rather than swallow it.
pass=0 fail=0 race=0
for t in "${tmps[@]}"; do
  p="$(grep -oE '[0-9]+ pass' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  f="$(grep -oE '[0-9]+ fail' "$t" | tail -1 | grep -oE '[0-9]+' || true)"
  pass=$((pass + ${p:-0}))
  fail=$((fail + ${f:-0}))
  if grep -qiE "EEXIST: file already exists, epoll_ctl|after the test run has completed" "$t"; then
    race=1
    echo "::error:: epoll race appeared in a SEPARATE-PROCESS shard — unexpected; dumping:"
    grep -iE "EEXIST|epoll|after the test run" "$t" | head -5
  fi
  # Surface any real failures from this shard.
  grep -E "\(fail\)|^error:|panic" "$t" | head -10 || true
  rm -f "$t"
done

echo "── unit: ${pass} pass / ${fail} fail across ${N} process-shards (parallel=1 each)"
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ] || [ "$race" -ne 0 ]; then
  exit 1
fi
exit 0
