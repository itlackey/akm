#!/usr/bin/env bash
#
# Publish a prerelease of the current release branch (docs/maintainers/release-checklist.md, step 2): dispatches the
# Release workflow on it with a stage. The workflow runs CI and Gated CI on the branch's head, then publishes
# <version>-<stage>.N to npm `next` and a GitHub prerelease, N one above the last for that stage.
#
# Usage:  bun run release:prerelease [alpha|beta|rc]     (default beta)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

stage="${1:-beta}"
case "$stage" in
  alpha|beta|rc) ;;
  *)
    echo "The stage is alpha, beta or rc, not $stage." >&2
    exit 1
    ;;
esac

branch="$(git branch --show-current)"
case "$branch" in
  release/*) ;;
  *)
    echo "Run this on the release branch (release/<version>); this is ${branch:-a detached HEAD}." >&2
    exit 1
    ;;
esac
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes; commit and push them first." >&2
  exit 1
fi
git fetch origin "$branch"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
  echo "$branch differs from origin/$branch; push or pull first." >&2
  exit 1
fi

gh workflow run release.yml --ref "$branch" -f "stage=$stage"
echo "Dispatched Release ($stage) on $branch. Follow it: gh run list --workflow release.yml --branch $branch"
