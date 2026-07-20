#!/usr/bin/env bash
#
# Local unit-test runner: shards the unit suite across separate OS processes
# for speed (min(nproc, 8) concurrent `bun test` processes).
#
# Sharding is done by EXPLICIT round-robin file lists, NOT bun's `--shard`:
# that flag's behavior varies silently across bun 1.3.x point releases (on
# 1.3.11 it slices tests from the `./tests` root; on 1.3.14 in CI it ran a
# quarter of the suite in shard 1 and ZERO tests in shards 2-4, all exit 0 —
# a silent 75% coverage hole the aggregate "pass" line masked). Explicit file
# lists are deterministic on every bun, and the files-ran cross-check below
# turns any future silent under-run into a hard failure.
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

# ── Slow-test skip (0.9.0 refactor, temporary) ───────────────────────────────
# The heaviest unit files (goldens/property suites, each 3-17s in-suite) are
# skipped in the LOCAL per-iteration gate so `check:fast` stays fast during the
# 0.9.0 bundle-adapter refactor. They are NEVER skipped in CI (CI=true) — the
# regression net stays complete there — and AKM_RUN_SLOW_TESTS=1 forces them in
# for chunk-boundary full runs; any single file can still be run directly with
# `bun test <file>`. REMOVE this block (restore full-suite defaults) when the
# refactor closes — tracked in docs/design/execution/.
SLOW_TESTS=(
  "goldens-proposal-txn.test.ts"
  "goldens-signal-delta-gate.test.ts"
  "rekey-merge-property.test.ts"
  "cutover-rekey-property-gate.test.ts"
  "goldens-cli-output.test.ts"
  "engine-ir-v3.test.ts"
  "goldens-mv-txn.test.ts"
  "goldens-cli-health-tasks.test.ts"
  "goldens-consolidate-ops.test.ts"
)
skip_slow=0
if [ "${AKM_RUN_SLOW_TESTS:-0}" != "1" ] && [ "${CI:-}" != "true" ]; then
  skip_slow=1
  echo "── unit: skipping ${#SLOW_TESTS[@]} slow file(s) locally (CI/AKM_RUN_SLOW_TESTS=1 run them)"
fi

# Deterministic file list; sort so every machine shards identically.
mapfile -t all_files < <(find tests -name '*.test.ts' -not -path 'tests/integration/*' | sort)
files=()
for f in "${all_files[@]}"; do
  if [ "$skip_slow" -eq 1 ]; then
    base="$(basename "$f")"
    skip=0
    for pat in "${SLOW_TESTS[@]}"; do
      [ "$base" = "$pat" ] && skip=1 && break
    done
    [ "$skip" -eq 1 ] && continue
  fi
  files+=("$f")
done
total="${#files[@]}"
if [ "$total" -eq 0 ]; then
  echo "── unit: no test files found under tests/ (excluding integration)" >&2
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
  ( bun test --timeout=30000 "${slice[@]}" >"$t" 2>&1 ) &
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

echo "── unit: ${pass} pass / ${fail} fail across ${N} process-shards (${filecount}/${total} files)"
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ] || [ "$filecount" -ne "$total" ]; then
  exit 1
fi
exit 0
