#!/usr/bin/env bash
#
# Run one test shard sequentially.
#
# CORRECTED DIAGNOSIS (2026-07-01): this shard previously ran `bun test
# --parallel=1 ...` on the theory that N=1 meant "no parallelism." Per `bun
# test --help`, `--parallel` "implies --isolate" and spawns a worker PROCESS
# over IPC even at N=1 — so every "isolated" shard was ALSO running Bun's
# isolate/worker-IPC machinery, which is what hangs under CPU contention (an
# fd recycled into a still-registered epoll slot). `--parallel` is never
# passed here — it adds a worker-IPC layer on top of `--isolate` for zero
# parallelism benefit at N=1.
#
# `--isolate` itself IS still passed, and must be: it runs each test file in a
# fresh global object, and at least one file (tests/embedder.test.ts, via
# `mock.module()`) depends on that to avoid leaking mocked module state into
# sibling files that land in the same shard process — reproduced as 34 real
# (non-hang) test failures when `--isolate` was dropped entirely, with zero
# CPU contention involved. So `--isolate` stays; only the redundant
# `--parallel` wrapper around it is gone. That cut the hang rate under
# simulated contention (8 shards pinned to 2 cores) from 4/8 to 1/8 in
# back-to-back runs of the same content — a large reduction, not a full
# elimination. The residual risk is `--isolate` itself under heavy contention,
# which behaves like a genuine Bun 1.3.x runtime issue below the application.
#
# The retry loop below is kept as a defensive backstop for that residual risk
# (real timeout, no output signature claiming a specific root cause), not as a
# blanket mask — a real assertion failure (any exit that isn't a timeout)
# still fails fast immediately, never retried.
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

# Per-attempt wall-clock cap. A clean unit shard finishes in ~20-45s (CI
# history: never above ~60s), so 120s is already generous — anything past it
# is a genuine hang, not slow tests, and waiting 300s just delays the kill
# (the 2026-07-02 release run burned 2×300s on one hung shard). Integration
# shards legitimately reach ~100s, so they keep a higher cap.
if [ "$suite" = "unit" ]; then
  PER_ATTEMPT_TIMEOUT="${SHARD_TIMEOUT:-120s}"
else
  PER_ATTEMPT_TIMEOUT="${SHARD_TIMEOUT:-300s}"
fi
MAX_ATTEMPTS="${SHARD_MAX_ATTEMPTS:-2}"

bun run sweep:tmp >/dev/null 2>&1 || true

ec=1
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "::group::shard $SHARD $suite — attempt $attempt/$MAX_ATTEMPTS"
  timeout --kill-after=15s "$PER_ATTEMPT_TIMEOUT" \
    bun test --isolate --timeout=30000 "${paths[@]}" --shard="$SHARD"
  ec=$?
  echo "::endgroup::"

  if [ "$ec" -eq 0 ]; then
    exit 0
  fi

  # 124 = `timeout` expired; 137 = SIGKILL (128+9) from --kill-after. Only a
  # timeout is retried — any other non-zero exit is a real test failure and
  # fails fast immediately, never retried.
  if [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ]; then
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "shard $SHARD $suite timed out (exit $ec) — retrying on a fresh process (attempt $((attempt + 1))/$MAX_ATTEMPTS)"
    else
      echo "shard $SHARD $suite timed out (exit $ec) on the final attempt"
    fi
    # Reap any orphan from the killed attempt before retrying. Guarded to CI
    # so a local run never kills a developer's other `bun test` processes.
    [ -n "${CI:-}" ] && pkill -9 -f 'bun test ' 2>/dev/null || true
    continue
  fi

  echo "shard $SHARD $suite FAILED with a real test error (exit $ec) — not a timeout, not retrying"
  exit "$ec"
done

echo "shard $SHARD $suite still timing out after $MAX_ATTEMPTS attempts"
exit "$ec"
