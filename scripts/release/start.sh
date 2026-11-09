#!/usr/bin/env bash
#
# Cut a release branch from main (docs/maintainers/release-checklist.md, step 1): release/<version>, with the next
# free number of the line. The default branch is the open release branch of main's line, the current minor, so
# fixes land where they ship next; a branch for the next minor never becomes the default. GitHub never deletes the
# default branch, so the merged release branch that held the default is deleted here once the default has moved.
# Needs a clean tree and `gh` logged in.
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
main_line="$(node -p "require('./package.json').version.replace(/^(0\.\d+)\..*$/, '\$1')")"
version="$(bun scripts/release-version.ts next ${line:+"$line"})"
branch="release/$version"
git switch -c "$branch"
git push -u origin "$branch"

if [ "${version%.*}" != "$main_line" ]; then
  echo "Cut $branch from main for the next minor. The default branch stays with the current minor; pull requests for $version choose $branch as their base."
  exit 0
fi

previous="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
gh repo edit --default-branch "$branch"
echo "Cut $branch from main and made it the default branch. Pull requests land there now."
case "$previous" in
  release/*)
    if git fetch origin "$previous" 2>/dev/null && git merge-base --is-ancestor "origin/$previous" origin/main; then
      git push origin --delete "$previous"
      echo "Deleted $previous: merged into main, and GitHub does not delete a default branch."
    fi
    ;;
esac
