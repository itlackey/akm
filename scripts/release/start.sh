#!/usr/bin/env bash
#
# Cut a release branch from main (docs/maintainers/release-checklist.md, step 1): release/<version>, with the next
# free number of the line. The default branch becomes the release branch taking new work, the newest line's; a
# patch branch for an older line leaves the default alone. Needs a clean tree and `gh` logged in.
#
# Usage:  bun run release:start            # the next number of main's line
#         bun run release:start 0.11       # the first number of a new line
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

default="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
default_minor=0
case "$default" in
  release/0.*) default_minor="${default#release/0.}"; default_minor="${default_minor%%.*}" ;;
esac
new_minor="${version#0.}"; new_minor="${new_minor%%.*}"
if [ "$new_minor" -ge "$default_minor" ]; then
  gh repo edit --default-branch "$branch"
  echo "Cut $branch from main and made it the default branch. Pull requests land there now."
else
  echo "Cut $branch from main. The default branch stays $default, the newer line."
fi
