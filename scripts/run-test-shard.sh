#!/usr/bin/env bash
#
# Run one test shard. The UNIT tier (fully in-memory) runs at --parallel=4 with
# NO retry wrapper — the epoll race cannot fire there (see #664 GATE MET below).
# The INTEGRATION tier (real-DB / spawn churn) runs at --parallel=1 and keeps
# the retry wrapper, retrying ONLY on the Bun 1.3.x --isolate fd/epoll race,
# NEVER on a real test failure — so genuine red tests fail fast and are never
# masked, while this known runtime bug self-heals on a fresh process.
#
# The same race (an fd recycled into a still-registered epoll slot; see
# release.yml header) has TWO manifestations, both retried on the integration
# path here:
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
#   - Bun.serve is FULLY drained from the unit tier (ALLOWED_SERVE is empty in
#     scripts/lint-tests-unit-purity.ts).
# #664 GATE MET (2026-06-24): the UNIT tier is now 100% in-memory — the storage
# in-memory DB pool (AKM_TEST_DB_INMEMORY=1) serves every unit DB from a pooled
# `:memory:` handle, Bun.serve is fully drained, and UNIT_PURITY_BASELINE === 0
# (ALLOWED_SERVE/SPAWN/FULL_INDEX all empty in lint-tests-unit-purity.ts). With
# no real fd churn the epoll race CANNOT fire on the unit path, so the unit
# branch runs at --parallel=4 with NO retry wrapper (a real failure or any
# non-zero exit fails fast immediately). The 3 residual load-flakes (NOT races —
# they failed under --parallel>1 load while passing at =1) were root-caused and
# stabilized in commit 21fdaef3 (health-command/-html-report shared-state +
# clock races, graph-boost stale cache key). Empirical proof: 20× at
# --parallel=4 = 0 fail / 0 RACE_SIGNATURE / 0 hang (4717 pass each). Gate
# preconditions E (search no longer mutates process.env.AKM_DISABLE_PROJECT_CONTEXT;
# resolved at the CLI edge) and F-min (getDbPath/getCacheDir/getDefaultStashDir
# take an injectable `env = process.env`) are both landed. See the
# `akm-bun-parallel-test-hang` memory.
#
# The retry wrapper survives ONLY on the INTEGRATION path, which still has
# real-DB / spawn fd churn and stays at --parallel=1 until that tier is purified
# (Phase 7).
#
# Usage:  SHARD=k/N scripts/run-test-shard.sh <unit|integration>
#
# Mirrors the `test:unit:shard` / `test:integration:shard` package.json scripts
# (kept there for local use). Paths are inlined here so `timeout` owns the
# `bun test` process directly and can hard-kill a hung run.
set -uo pipefail

suite="${1:?usage: $0 <unit|integration>}"
: "${SHARD:?set SHARD=k/N}"

# Per-suite defaults. The UNIT tier is fully in-memory (AKM_TEST_DB_INMEMORY=1,
# pooled :memory: DBs, 0 Bun.serve, UNIT_PURITY_BASELINE === 0), so the
# epoll/fd race CANNOT fire there — it runs at --parallel=4 with NO retry
# wrapper (see the unit branch below). The INTEGRATION tier still has real-DB
# and spawn churn, so it stays at --parallel=1 and keeps the retry wrapper.
case "$suite" in
  unit)
    paths=(./tests --path-ignore-patterns=tests/integration)
    default_parallel=4
    ;;
  integration)
    paths=(./tests/integration ./tests/commands ./tests/workflows)
    default_parallel=1
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

# In-process parallelism per shard. Defaulted per suite (above): unit=4 (the
# in-memory pool eliminated the race; the #664 gate is met — see below),
# integration=1 (real-DB churn). Override with SHARD_PARALLEL.
#
# #664 GATE MET (2026-06-24): the unit tier flipped to --parallel=4 after the
# in-memory DB pool removed the race surface (unit is 100% :memory:), the 3
# residual load-flakes were root-caused and stabilized (commit 21fdaef3:
# health-command/-html-report shared-state + clock races, graph-boost stale
# cache key), and the empirical proof ran 20× at --parallel=4 with 0 fail /
# 0 RACE_SIGNATURE / 0 hang (4717 pass each). Preconditions E + F-min are
# landed and UNIT_PURITY_BASELINE === 0. Per C6.4 the epoll retry wrapper is
# DELETED from the unit path (dead code there) and kept ONLY for integration.
SHARD_PARALLEL="${SHARD_PARALLEL:-$default_parallel}"

bun run sweep:tmp >/dev/null 2>&1 || true

# ── UNIT path: pure in-memory tier, no race possible → single attempt, no retry.
# A real assertion failure or any non-zero exit fails fast immediately. We do
# NOT retry on the epoll race signature here because that race cannot fire in a
# fully :memory: tier (C6.4: the wrapper would be dead code on this path).
if [ "$suite" = "unit" ]; then
  echo "::group::shard $SHARD unit (--parallel=$SHARD_PARALLEL, in-memory, no-retry)"
  timeout --kill-after=15s "$PER_ATTEMPT_TIMEOUT" \
    bun test --parallel="$SHARD_PARALLEL" --timeout=30000 "${paths[@]}" --shard="$SHARD"
  ec=$?
  echo "::endgroup::"
  exit "$ec"
fi

# ── INTEGRATION path: real-DB / spawn churn remains, so the Bun --isolate
# epoll fd race can still surface. Keep the retry-on-race-signature wrapper as
# defence-in-depth until that tier is purified (Phase 7).
#
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
    bun test --parallel="$SHARD_PARALLEL" --timeout=30000 "${paths[@]}" --shard="$SHARD" 2>&1 | tee "$out_file"
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
