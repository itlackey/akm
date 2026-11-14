#!/usr/bin/env bash
#
# The release steps of docs/maintainers/release-checklist.md, one subcommand each:
#
#   start [0.<minor>]       cut release/<version> from main with the next free number of the line
#   prerelease [stage]      dispatch the Release workflow on the current release branch (alpha, beta or rc; beta)
#   stable                  set the version, cut the changelog, commit `release: <version>`, push, open the PR into main
#
# Every step needs a clean tree; prerelease and stable run on a release branch that is in sync with origin.
#
# Usage:  bun run release:start [0.<minor>] | bun run release:prerelease [stage] | bun run release:stable
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The current branch is release/<version> and matches origin. Sets $branch and $version.
on_release_branch() {
  branch="$(git branch --show-current)"
  case "$branch" in
    release/*) ;;
    *)
      echo "Run this on the release branch (release/<version>); this is ${branch:-a detached HEAD}." >&2
      exit 1
      ;;
  esac
  version="${branch#release/}"
  git fetch origin "$branch"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
    echo "$branch differs from origin/$branch; push or pull first." >&2
    exit 1
  fi
}

start() {
  git fetch origin main
  git switch --detach origin/main
  version="$(bun scripts/release-version.ts next ${1:+"$1"})"
  branch="release/$version"
  git switch -c "$branch"
  git push -u origin "$branch"
  echo "Cut $branch from main. Pull requests for it use --base $branch."
}

prerelease() {
  local stage="${1:-beta}"
  case "$stage" in
    alpha|beta|rc) ;;
    *)
      echo "The stage is alpha, beta or rc, not $stage." >&2
      exit 1
      ;;
  esac
  on_release_branch
  gh workflow run release.yml --ref "$branch" -f "stage=$stage"
  echo "Dispatched Release ($stage) on $branch. Follow it: gh run list --workflow release.yml --branch $branch"
}

# The release pull request's gate runs on HEAD: its first check, release-branch-only, is there and is not the
# skipped one of a draft's run. Looks for up to a minute.
gate_started() {
  local sha
  sha="$(git rev-parse HEAD)"
  for _ in 1 2 3 4 5 6; do
    sleep 10
    if [ "$(gh api "repos/{owner}/{repo}/commits/$sha/check-runs?check_name=release-branch-only" \
      --jq 'any(.check_runs[]; .conclusion != "skipped")')" = "true" ]; then
      return 0
    fi
  done
  return 1
}

stable() {
  on_release_branch
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
  # A draft opened earlier becomes the release pull request; marking it ready runs the whole gate on this commit.
  existing="$(gh pr list --base main --head "$branch" --state open --json number,url --jq '.[:1][] | "\(.number) \(.url)"')"
  if [ -n "$existing" ]; then
    gh pr ready "${existing%% *}"
    # Marked ready seconds after the push, GitHub can start only the draft's run, which skips every job (it did
    # for 0.10.261121). Marking the pull request ready again starts the gate.
    if ! gate_started; then
      gh pr ready "${existing%% *}" --undo
      gh pr ready "${existing%% *}"
      if ! gate_started; then
        echo "The gate did not start on ${existing#* }. Mark the pull request draft, then ready, to run it." >&2
        exit 1
      fi
    fi
    # gh pr edit fails on the deprecated Projects (classic) GraphQL field; the REST call sets only the title.
    gh api -X PATCH "repos/{owner}/{repo}/pulls/${existing%% *}" -f title="release: $version" --silent
    url="${existing#* }"
  else
    url="$(gh pr create --base main --head "$branch" --title "release: $version" \
      --body "Ships $version. Merging publishes it: npm latest, the GitHub release, AKM Desktop and akm-web (docs/maintainers/release-checklist.md).")"
  fi
  echo "Release pull request: $url"
  echo "Merge it when green. The push to main publishes $version. Then run: bun run release:start"
}

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes; commit or stash them first." >&2
  exit 1
fi
case "${1:-}" in
  start|prerelease|stable) "$1" "${2:-}" ;;
  *)
    echo "usage: scripts/release.sh start [0.<minor>] | prerelease [alpha|beta|rc] | stable" >&2
    exit 2
    ;;
esac
