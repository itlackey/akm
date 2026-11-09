#!/usr/bin/env bash
#
# Cut the next release branch from main and make it the repository's default
# branch (docs/maintainers/release-checklist.md, step 1). Run it right after
# the previous release branch merged. Needs a clean tree and `gh` logged in.
#
# Usage:  bun run release:start
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes; commit or stash them first." >&2
  exit 1
fi

open="$(git ls-remote --heads origin 'release/*' | awk '{ sub("refs/heads/", "", $2); print $2 }')"
if [ -n "$open" ]; then
  echo "A release branch is already open: $open. One release branch is open at a time; ship or delete it first." >&2
  exit 1
fi

git fetch origin main
git switch --detach origin/main
version="$(bun scripts/release-version.ts next)"
branch="release/$version"
git switch -c "$branch"
git push -u origin "$branch"
gh repo edit --default-branch "$branch"
echo "Cut $branch from main and made it the default branch. Pull requests land there now."
