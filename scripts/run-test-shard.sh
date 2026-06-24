#!/usr/bin/env bash
#
# Run one test shard sequentially, retrying ONLY on the Bun 1.3.x --isolate
# fd/epoll race, NEVER on a real test failure — so genuine red tests fail fast
# and are never masked, while this known runtime bug self-heals on a fresh
# process.
#
# The same race (an fd recycled into a still-registered epoll slot; see
# release.yml header) has TWO manifestations, both retried here:
#   1. HANG  — a worker parks forever in ep_poll. `timeout` kills it (exit
#              124, or 137 from --kill-after SIGKILL).
#   2. CRASH — the runtime aborts with `EEXIST: file already exists, epoll_ctl`
#              and the runner then reports `Cannot call <hook>() after the test
#              run has completed`. The process exits non-zero with an ordinary
#              code (e.g. 1), so it is detected by the signature in the output,
#              NOT by exit code.
# Both strings are emitted by the Bun runtime itself, never by a failed
# expect(), so retrying on them cannot mask a genuine red test. A real
# assertion failure (no signature, non-timeout exit) fails fast immediately.
#
# #664 DECISION (root-cause work, not just self-heal): the race trigger is
# real-`spawnSync`/`Bun.serve` fd churn. We are draining that churn out of the
# UNIT tree so the race surface shrinks shard by shard:
#   - The heaviest churners were relocated into tests/integration/ (out of the
#     `test:unit` shards): the git-`spawnSync` `write-source.test.ts` (the
#     deterministic shard-5 crasher) and the real-`bun`-spawn `env-path-run.test.ts`.
#   - The shared fixture loader (tests/fixtures/stashes/load.ts) now indexes
#     in-process instead of spawning `bun run … index`.
#   - registry-search.test.ts shares ONE Bun.serve instead of ~40.
# This retry wrapper stays as DEFENCE-IN-DEPTH: ~45 unit files still spawn, so
# the race can still surface. Re-evaluating `--parallel>1` (TEST_PARALLEL) and/or
# a Bun upgrade is gated on draining the remaining churners; do NOT flip
# parallelism back on until the unit tree is spawn-light and a Bun build without
# the epoll collision is confirmed. See the `akm-bun-parallel-test-hang` memory.
#
# Usage:  SHARD=k/N scripts/run-test-shard.sh <unit|integration>
#
# Mirrors the `test:unit:shard` / `test:integration:shard` package.json scripts
# (kept there for local use). Paths are inlined here so `timeout` owns the
# `bun test` process directly and can hard-kill a hung run.
set -uo pipefail

suite="${1:?usage: $0 <unit|integration>}"
: "${SHARD:?set SHARD=k/N}"

case "$suite" in
  unit)
    paths=(./tests --path-ignore-patterns=tests/integration)
    ;;
  integration)
    paths=(./tests/integration ./tests/commands ./tests/workflows)
    ;;
  *)
    echo "usage: $0 <unit|integration>" >&2
    exit 2
    ;;
esac

# Per-attempt wall-clock cap. A clean shard finishes in ~20-45s; anything past a
# few minutes is the hang, not slow tests.
PER_ATTEMPT_TIMEOUT="${SHARD_TIMEOUT:-300s}"
MAX_ATTEMPTS="${SHARD_MAX_ATTEMPTS:-3}"

bun run sweep:tmp >/dev/null 2>&1 || true

# Signature of the Bun --isolate fd/epoll race in captured output. Emitted by
# the runtime, never by a failed expect() — so matching it cannot mask a real
# red test. The post-completion hook error is the corruption that follows the
# EEXIST abort.
RACE_SIGNATURE='EEXIST: file already exists, epoll_ctl|Cannot call (beforeEach|afterEach|beforeAll|afterAll)\(\) after the test run has completed'

ec=1
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "::group::shard $SHARD $suite — attempt $attempt/$MAX_ATTEMPTS"
  out_file="$(mktemp)"
  # Tee so we can inspect the output for the race signature while still
  # streaming it to the CI log live. PIPESTATUS[0] is bun's real exit code.
  timeout --kill-after=15s "$PER_ATTEMPT_TIMEOUT" \
    bun test --parallel=1 --timeout=30000 "${paths[@]}" --shard="$SHARD" 2>&1 | tee "$out_file"
  ec="${PIPESTATUS[0]}"
  echo "::endgroup::"

  if [ "$ec" -eq 0 ]; then
    rm -f "$out_file"
    exit 0
  fi

  # 124 = `timeout` expired; 137 = SIGKILL (128+9) from --kill-after → the hang
  # manifestation. The crash manifestation exits with an ordinary code but
  # leaves the race signature in the output. Either is the known runtime bug.
  is_race=false
  if [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ]; then
    echo "shard $SHARD $suite HUNG (exit $ec) — Bun --isolate epoll busy-spin"
    is_race=true
  elif grep -qE "$RACE_SIGNATURE" "$out_file"; then
    echo "shard $SHARD $suite hit the Bun --isolate epoll_ctl EEXIST race (exit $ec)"
    is_race=true
  fi
  rm -f "$out_file"

  if [ "$is_race" = true ]; then
    echo "  → known Bun runtime race (not an assertion failure); retrying on a fresh process"
    # Reap any orphan from the killed/aborted attempt before retrying. Guarded to
    # CI so a local run never kills a developer's other `bun test` processes.
    [ -n "${CI:-}" ] && pkill -9 -f 'bun test ' 2>/dev/null || true
    continue
  fi

  echo "shard $SHARD $suite FAILED with a real test error (exit $ec) — not a hang/race, not retrying"
  exit "$ec"
done

echo "shard $SHARD $suite still failing after $MAX_ATTEMPTS attempts (Bun epoll race did not clear)"
exit "$ec"
