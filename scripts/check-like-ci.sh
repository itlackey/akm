#!/usr/bin/env bash
#
# Pre-push check that runs the way CI's `check` job does (.github/workflows/ci.yml):
# Bun and Node at the versions CI pins (read from ci.yml), a clean
# `bun install --frozen-lockfile`, then `bun run check` with CI=true and
# TEST_SHARDS=4 (the runner's four cores). Locally those three differ (a newer
# Bun, up to 8 shards, no CI), and a failure that depends on one of them only
# showed up as a CI round.
#
# The checkout is mounted into a container, with its node_modules (and dist/, if
# built) replaced by scratch tmpfs mounts: the install leaves yours alone, and a
# built dist/ does not switch on tests that CI's fresh checkout skips. The image
# is built from the pinned base images on the first run and cached by Docker
# after that.
#
# Usage:  bun run check:ci
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_WORKFLOW="$ROOT/.github/workflows/ci.yml"
BUN_VERSION="$(awk '/^ *bun-version:/ { print $2; exit }' "$CI_WORKFLOW")"
NODE_VERSION="$(awk '/^ *node-version:/ { print $2; exit }' "$CI_WORKFLOW")"
if [ -z "$BUN_VERSION" ] || [ -z "$NODE_VERSION" ]; then
  echo "Could not read the Bun and Node versions from $CI_WORKFLOW" >&2
  exit 1
fi

IMAGE="akm-check-like-ci:bun-$BUN_VERSION-node-$NODE_VERSION"
docker build --quiet --tag "$IMAGE" - <<EOF
FROM node:$NODE_VERSION-bookworm-slim
COPY --from=oven/bun:$BUN_VERSION /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx \\
  && apt-get update \\
  && apt-get install -y --no-install-recommends git procps \\
  && rm -rf /var/lib/apt/lists/*
EOF

# A linked worktree's .git file points into the main repository's git directory,
# so that directory is mounted, read-only, at the same path.
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"

# Docker would create a missing mount point owned by root.
mkdir -p "$ROOT/node_modules"
scratch=(--tmpfs "$ROOT/node_modules:rw,exec,size=4g,uid=$(id -u),gid=$(id -g)")
if [ -d "$ROOT/dist" ]; then
  scratch+=(--tmpfs "$ROOT/dist:rw,exec,size=1g,uid=$(id -u),gid=$(id -g)")
fi

# A Ctrl-C reaches only the container's sh, which waits on bun, so the run
# would go on for minutes: run it in the background and stop the container on
# INT or TERM instead.
container="akm-check-like-ci-$$"
trap 'docker kill "$container" >/dev/null 2>&1 || true' INT TERM
docker run --rm --init --name "$container" \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/home \
  --env CI=true \
  --env TEST_SHARDS=4 \
  --volume "$ROOT:$ROOT" \
  --volume "$GIT_COMMON_DIR:$GIT_COMMON_DIR:ro" \
  "${scratch[@]}" \
  --workdir "$ROOT" \
  "$IMAGE" \
  sh -c 'mkdir -p "$HOME" && bun install --frozen-lockfile && bun run check' &
wait "$!"
