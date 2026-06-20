#!/usr/bin/env bash
#
# Run one test shard sequentially, retrying ONLY on a hang (timeout / SIGKILL),
# NEVER on a real test failure — so genuine red tests fail fast and are never
# masked, while the rare Bun 1.3.x --isolate busy-spin hang (a worker parked
# forever in ep_poll; see release.yml header) self-heals on a fresh process.
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

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "::group::shard $SHARD $suite — attempt $attempt/$MAX_ATTEMPTS"
  timeout --kill-after=15s "$PER_ATTEMPT_TIMEOUT" \
    bun test --parallel=1 --timeout=30000 "${paths[@]}" --shard="$SHARD"
  ec=$?
  echo "::endgroup::"

  if [ "$ec" -eq 0 ]; then
    exit 0
  fi

  # 124 = `timeout` expired; 137 = SIGKILL (128+9) from --kill-after. Both mean
  # the run hung, not that a test asserted false. Only these are retried.
  if [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ]; then
    echo "shard $SHARD $suite HUNG (exit $ec) — Bun --isolate epoll busy-spin; retrying on a fresh process"
    # Reap any orphan from the killed attempt before retrying. Guarded to CI so a
    # local run never kills a developer's other `bun test` processes.
    [ -n "${CI:-}" ] && pkill -9 -f 'bun test ' 2>/dev/null || true
    continue
  fi

  echo "shard $SHARD $suite FAILED with a real test error (exit $ec) — not a hang, not retrying"
  exit "$ec"
done

echo "shard $SHARD $suite still hung after $MAX_ATTEMPTS attempts"
exit 124
