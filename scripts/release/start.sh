#!/usr/bin/env bash
#
# Cut a release branch from main (docs/maintainers/release-checklist.md, step 1): release/<version>, with the next
# free number of the line. Needs a clean tree.
#
# Usage:  bun run release:start            # the next number of main's line
#         bun run release:start 0.11       # the first number of the next minor
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

line="${1:-}"
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes; commit or stash them first." >&2
  exit 1
fi

git fetch origin main
git switch --detach origin/main
version="$(bun scripts/release-version.ts next ${line:+"$line"})"
branch="release/$version"
git switch -c "$branch"
git push -u origin "$branch"
echo "Cut $branch from main. Pull requests for it use --base $branch."
