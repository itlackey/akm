#!/usr/bin/env bash
#
# Run one test shard sequentially.
#
# `--isolate` is required for correctness: it runs each test file in a fresh
# global object, and files using `mock.module()` (e.g. tests/embedder.test.ts)
# leak mocked module state into sibling files without it — reproduced as 34
# real failures when it was dropped. `--parallel` is never passed: per `bun
# test --help` it "implies --isolate" but ALSO spawns a worker process over
# IPC even at N=1, adding the layer where the fd/epoll race bites hardest.
#
# Bun 1.3.x has a residual runtime race in `--isolate` under CPU contention
# (an fd recycled into a still-registered epoll slot). It has TWO
# manifestations, both retried here on a fresh process:
#   1. the HANG — the run busy-spins forever; caught by the wall-clock
#      `timeout` (exit 124/137);
#   2. the CRASH — `EEXIST: file already exists, epoll_ctl` followed by
#      "Cannot call beforeEach() after the test run has completed"; exits with
#      an ordinary failure code but leaves that signature in the output
#      (observed again 2026-07-02 on CI after the signature retry had been
#      dropped in the --parallel removal rewrite).
# Both signatures are emitted by the runtime, never by a failed expect(), so
# retrying on them cannot mask a real red test. Any other non-zero exit fails
# fast immediately, never retried.
#
# Usage:  SHARD=k/N scripts/run-test-shard.sh <unit|integration>
#
# This is the single definition of the shard invocation (CI and local); the
# per-test timeout comes from bunfig.toml.
set -uo pipefail

suite="${1:?usage: $0 <unit|integration>}"
: "${SHARD:?set SHARD=k/N}"

case "$suite" in
  unit)
    paths=(./tests --path-ignore-patterns=tests/integration)
    ;;
  integration)
    paths=(./tests/integration)
    ;;
  *)
    echo "usage: $0 <unit|integration>" >&2
    exit 2
    ;;
esac

# Per-attempt wall-clock cap. A clean unit shard finishes in ~20-45s (CI
# history: never above ~60s), so 120s is already generous — anything past it
# is a genuine hang, not slow tests. Integration shards legitimately reach
# ~100s, so they keep a higher cap.
if [ "$suite" = "unit" ]; then
  PER_ATTEMPT_TIMEOUT="${SHARD_TIMEOUT:-120s}"
else
  PER_ATTEMPT_TIMEOUT="${SHARD_TIMEOUT:-300s}"
fi
MAX_ATTEMPTS="${SHARD_MAX_ATTEMPTS:-2}"

bun run sweep:tmp >/dev/null 2>&1 || true

# Signature of the Bun --isolate fd/epoll race in captured output (crash
# manifestation #2 above).
RACE_SIGNATURE='EEXIST: file already exists, epoll_ctl|Cannot call (beforeEach|afterEach|beforeAll|afterAll)\(\) after the test run has completed'

ec=1
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "::group::shard $SHARD $suite — attempt $attempt/$MAX_ATTEMPTS"
  out_file="$(mktemp)"
  # Tee so the output can be checked for the race signature while still
  # streaming to the CI log live. PIPESTATUS[0] is bun's real exit code.
  timeout --kill-after=15s "$PER_ATTEMPT_TIMEOUT" \
    bun test --isolate "${paths[@]}" --shard="$SHARD" 2>&1 | tee "$out_file"
  ec="${PIPESTATUS[0]}"
  echo "::endgroup::"

  if [ "$ec" -eq 0 ]; then
    rm -f "$out_file"
    exit 0
  fi

  is_race=false
  if [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ]; then
    echo "shard $SHARD $suite timed out (exit $ec) — Bun --isolate hang manifestation"
    is_race=true
  elif grep -qE "$RACE_SIGNATURE" "$out_file"; then
    echo "shard $SHARD $suite hit the Bun --isolate epoll_ctl EEXIST race (exit $ec)"
    is_race=true
  fi
  rm -f "$out_file"

  if [ "$is_race" = true ]; then
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "  → known Bun runtime race (not an assertion failure); retrying on a fresh process (attempt $((attempt + 1))/$MAX_ATTEMPTS)"
    else
      echo "  → known Bun runtime race, but this was the final attempt"
    fi
    # Reap any orphan from the killed attempt before retrying. Guarded to CI
    # so a local run never kills a developer's other `bun test` processes.
    [ -n "${CI:-}" ] && pkill -9 -f 'bun test ' 2>/dev/null || true
    continue
  fi

  echo "shard $SHARD $suite FAILED with a real test error (exit $ec) — not a hang/race, not retrying"
  exit "$ec"
done

echo "shard $SHARD $suite still failing on the runtime race after $MAX_ATTEMPTS attempts"
exit "$ec"
