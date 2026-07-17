#!/usr/bin/env bash
#
# Local unit-test runner: shards the unit suite across separate OS processes
# for speed (min(nproc, 8) concurrent `bun test` processes, each on a
# deterministic --shard slice).
#
# Neither `--isolate` nor `--parallel` is passed (isolate removed 2026-07-02
# on the di-seams branch):
#   - `--parallel` (any N, including 1) implies `--isolate` and spawns worker
#     processes over IPC — the Bun 1.3.x path with the intermittent
#     `EEXIST epoll_ctl` race (#664). Never re-add it.
#   - `--isolate` was only needed while test files leaked `mock.module()`
#     state into siblings in the same process. After the DI-seams refactor,
#     `mock.module` is at ZERO across the tree (the last three @clack/prompts
#     suites now go through the src/cli/clack seam) — enforced by grep and
#     required, because a two-file probe proved `mock.restore()` does NOT
#     clear module mocks (they leak across files without --isolate).
#     Verified by repeated green full-suite runs without `--isolate`.
#     Dropping it removes the racy isolate machinery entirely and saves the
#     per-file fresh-global overhead.
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

# ── Slow-test skip (0.9.0 refactor, temporary) ───────────────────────────────
# The heaviest unit files (goldens/property suites, each 3-17s in-suite) are
# skipped by default so the per-iteration `check:fast` gate stays fast during the
# 0.9.0 bundle-adapter refactor. Set AKM_RUN_SLOW_TESTS=1 to include them (CI and
# chunk-boundary full runs do this); any single file can still be run directly
# with `bun test <file>`. REMOVE this block (and restore full-suite defaults)
# when the refactor closes — tracked in docs/design/execution/.
SLOW_TESTS=(
  "**/goldens-proposal-txn.test.ts"
  "**/goldens-signal-delta-gate.test.ts"
  "**/rekey-merge-property.test.ts"
  "**/goldens-cli-output.test.ts"
  "**/engine-ir-v3.test.ts"
  "**/goldens-mv-txn.test.ts"
  "**/goldens-cli-health-tasks.test.ts"
  "**/goldens-consolidate-ops.test.ts"
)
if [ "${AKM_RUN_SLOW_TESTS:-0}" != "1" ]; then
  for pat in "${SLOW_TESTS[@]}"; do
    paths+=(--path-ignore-patterns="$pat")
  done
  echo "── unit: skipping ${#SLOW_TESTS[@]} slow file(s) (set AKM_RUN_SLOW_TESTS=1 to include)"
fi
declare -a pids tmps
for k in $(seq 1 "$N"); do
  t="$(mktemp)"
  tmps+=("$t")
  ( bun test --timeout=30000 "${paths[@]}" --shard="$k/$N" >"$t" 2>&1 ) &
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

echo "── unit: ${pass} pass / ${fail} fail across ${N} process-shards"
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ]; then
  exit 1
fi
exit 0
