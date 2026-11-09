#!/usr/bin/env bash
#
# Ship the current release branch as a stable release (docs/maintainers/release-checklist.md, step 3): sets
# package.json to the branch's version, cuts the changelog, commits `release: <version>`, pushes, and opens the
# pull request into main. Merging that pull request publishes. Add a migration note first if the release needs one.
#
# Usage:  bun run release:stable
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

branch="$(git branch --show-current)"
case "$branch" in
  release/*) ;;
  *)
    echo "Run this on the release branch (release/<version>); this is ${branch:-a detached HEAD}." >&2
    exit 1
    ;;
esac
version="${branch#release/}"
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes; commit or stash them first." >&2
  exit 1
fi
git fetch origin "$branch"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
  echo "$branch differs from origin/$branch; push or pull first." >&2
  exit 1
fi
if ! grep -q '^## \[Unreleased\]$' CHANGELOG.md; then
  echo "CHANGELOG.md has no '## [Unreleased]' section to cut." >&2
  exit 1
fi

npm pkg set version="$version"
# The Unreleased entries become this release's section, under a fresh empty Unreleased heading.
awk -v version="$version" -v date="$(date -u +%F)" '
  !cut && $0 == "## [Unreleased]" { print; print ""; print "## [" version "] - " date; cut = 1; next }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
# Pins the changelog cut against package.json before anything is pushed.
bun test tests/workflow-release.test.ts

git add package.json CHANGELOG.md
git commit -m "release: $version"
git push
url="$(gh pr create --base main --head "$branch" --title "release: $version" \
  --body "Ships $version. Merging publishes it: npm latest, the GitHub release, AKM Desktop and akm-web (docs/maintainers/release-checklist.md).")"
echo "Opened $url"
echo "Merge it when green. The push to main publishes $version. Then run: bun run release:start"
