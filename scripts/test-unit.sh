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

# Deterministic file list; sort so every machine shards identically. (The
# 0.9.0-refactor-era local slow-file skip-list was removed at refactor close
# per its own charter; the full suite always runs, local and CI alike.)
mapfile -t files < <(find tests -name '*.test.ts' -not -path 'tests/integration/*' | sort)
total="${#files[@]}"
if [ "$total" -eq 0 ]; then
  echo "── unit: no test files found under tests/ (excluding integration)" >&2
  exit 1
fi
[ "$N" -gt "$total" ] && N="$total"

# Shard logs live in an announced directory (not anonymous mktemp files) so a
# hung or long run can be watched live: `tail -f <dir>/shard-*.log`. Honors
# $TMPDIR; kept on failure for diagnosis, removed on success.
logdir="$(mktemp -d "${TMPDIR:-/tmp}/akm-unit-shards.XXXXXX")"
echo "── unit: ${N} shards over ${total} files; live logs: ${logdir}/shard-N.log"

declare -a pids tmps
for k in $(seq 0 $((N - 1))); do
  slice=()
  for i in "${!files[@]}"; do
    [ $((i % N)) -eq "$k" ] && slice+=("${files[$i]}")
  done
  t="${logdir}/shard-$((k + 1)).log"
  tmps+=("$t")
  # 120s per-test (matches the integration runner): under N-way process
  # contention the heaviest property/goldens suites legitimately run 3-4x
  # their solo duration; the timeout exists to catch HANGS.
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
    echo "── shard log tail (last 80 lines): ${t} ──"
    tail -80 "$t"
  fi
done

echo "── unit: ${pass} pass / ${fail} fail across ${N} process-shards (${filecount}/${total} files)"
if [ "$rc" -ne 0 ] || [ "$fail" -ne 0 ] || [ "$filecount" -ne "$total" ]; then
  echo "── unit: shard logs kept for diagnosis: ${logdir}"
  exit 1
fi
rm -rf "$logdir"
exit 0
