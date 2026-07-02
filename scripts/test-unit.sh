#!/usr/bin/env bash
#
# Local unit-test runner: fast, isolated, and shards across separate processes
# instead of Bun's own (unstable) in-process worker parallelism.
#
# WHY THIS EXISTS (the #664 fix, corrected 2026-07-01). `bun test --parallel=N`
# runs test files as worker PROCESSES over IPC and (per `bun test --help`)
# "implies --isolate" at any N, including N=1. On Bun 1.3.x that isolate/
# worker-IPC path intermittently hits an `EEXIST: file already exists,
# epoll_ctl` race, which aborts the run or busy-spins to a hang.
#
# `--parallel=1` was previously passed to every shard on the theory that N=1
# meant "disable parallelism, so no race." It does not disable the isolate
# machinery (confirmed: it prints a "1x PARALLEL" banner and is measurably
# slower than a bare invocation), so every shard was still running the exact
# path that causes the race — just with one worker.
#
# The fix is NOT to drop `--isolate` entirely: it is required for correctness,
# not just an anti-hang nicety. `--isolate` runs each test file in a fresh
# global object; several files (e.g. tests/embedder.test.ts, which calls
# `mock.module()`) mutate shared/global module state, and WITHOUT --isolate
# those mutations leak across sibling files that happen to land in the same
# shard process — reproduced locally as 34 real test failures with zero CPU
# contention, not just under load. So each shard here runs `bun test
# --isolate` (isolation ON) but WITHOUT `--parallel` (no extra worker-process/
# IPC layer on top of it, since N=1 buys no real parallelism anyway). Under
# simulated CPU contention (8 concurrent shards pinned to 2 cores, matching a
# GitHub Actions runner) this cut the hang rate from 4/8 shards (with
# `--parallel=1`) to 1/8 (with `--isolate` alone) in back-to-back runs of the
# same test content — a large reduction, not a full elimination; the
# remaining risk is `--isolate` itself under heavy contention, which appears
# to be a genuine Bun 1.3.x runtime issue below the application. Sharding
# across separate OS processes (this script) is what keeps that residual risk
# contained to one shard instead of corrupting the whole run; `run-test-
# shard.sh`'s single retry-on-timeout is the remaining backstop for it in CI.
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
  ( bun test --isolate "${paths[@]}" --shard="$k/$N" >"$t" 2>&1 ) &
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

echo "── unit: ${pass} pass / ${fail} fail across ${N} process-shards"
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ] || [ "$race" -ne 0 ]; then
  exit 1
fi
exit 0
