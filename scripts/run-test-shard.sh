#!/usr/bin/env bash
#
# Run one test shard sequentially.
#
# `--isolate` is deliberately NOT passed (removed 2026-07-02 on the di-seams
# branch). It was only ever needed because test files leaked `mock.module()`
# state into sibling files in the same process. After the DI-seams refactor,
# `mock.module` is at ZERO across the tree (the last three @clack/prompts
# suites migrated onto the src/cli/clack seam). Zero is mandatory: a two-file
# probe proved a `mock.module` in file A IS visible in file B and
# `mock.restore()` does NOT clear module mocks — so de-isolation is only
# sound with no `mock.module` at all. Verified by repeated green full-suite
# runs without `--isolate`, including concurrent runs under CPU contention.
# Dropping `--isolate` also drops the Bun 1.3.x isolate/worker epoll_ctl
# EEXIST race that used to require a signature-gated retry here.
# `--parallel` must never be passed either: per `bun test --help` it "implies
# --isolate" (re-adding the racy path) even at N=1.
#
# Usage:  SHARD=k/N scripts/run-test-shard.sh <unit|integration>
#
# This is the single definition of the shard invocation (CI and local).
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

# Individual tests have a 30-second limit below. This outer limit only catches
# a stuck runner or process cleanup and leaves margin inside CI's 20-minute job.
PER_ATTEMPT_TIMEOUT="${SHARD_TIMEOUT:-900s}"

bun run sweep:tmp >/dev/null 2>&1 || true

# --timeout=30000 must stay on the command line: bun 1.3.14 does NOT honor
# bunfig.toml's [test] timeout (verified: a 7s test dies at the 5s default
# without this flag — which failed 5 CI shards on 2026-07-02).
timeout --kill-after=15s "$PER_ATTEMPT_TIMEOUT" \
  bun test --timeout=30000 "${paths[@]}" --shard="$SHARD"
ec=$?
if [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ]; then
  echo "shard $SHARD $suite timed out (exit $ec) — genuine hang, investigate"
fi
exit "$ec"
