# Release Checklist

## Branch model

`main` is the stable line. Every commit on it is a release: tagged `v<version>`,
on npm `latest`, with a GitHub release that carries the binaries, the installers
and AKM Desktop. Only a release branch merges to `main`.

One release branch is open at a time, `release/<cut date>` (for example
`release/2026-11-09`; a second cut on the same day adds a letter,
`release/2026-11-09b`). While it is open it is the repository's default branch,
so pull requests target it without anyone choosing. Every change lands on it by
pull request: features, fixes, docs. The branch name carries the date and not a
version because the branch publishes several versions over its life (betas, then
the stable), each with its own number ([Versions](#versions)).

The release branch is always shippable: a pull request merges when the branch
would still ship with it in. A feature that is not ready waits in its pull
request, not the release.

- A feature that needs several pull requests lands in slices that are each
  shippable but inert until the last one (internals first, the command or flag
  wired up last, or marked Experimental in [`STABILITY.md`](../../STABILITY.md)).
  When slices cannot be inert, use a feature branch off the release branch,
  with pull requests into it and one pull request from it into the release
  branch. Merge the release branch into a feature branch that lives more than a
  few days, and do not let one outlive two releases.
- A pull request that depends on another sets that pull request's branch as its
  base; GitHub retargets it to the release branch when the first one merges.
- A bug in stable is fixed in the next release. There is no hotfix branch; the
  next release is a cut, a pull request and a merge away. A change that turns
  out wrong is reverted on the release branch.
- While the release branch's pull request into `main` is open, nothing else
  merges into the release branch. The window is the gate's run time.

## 1. Cut a release branch

Right after the previous release branch merged (GitHub deletes it, see
[Repository settings](#repository-settings)):

```sh
git fetch origin main
git switch -c release/$(date -u +%F) origin/main
git push -u origin HEAD
gh repo edit --default-branch release/<cut date>
```

## 2. Prerelease

When the branch is worth trying before it ships, on the release branch:

1. Set the version: `npm pkg set version="$(bun scripts/release-version.ts next)"`.
2. Cut the changelog: add `## [<version>] - <YYYY-MM-DD>` (UTC date) directly
   under `## [Unreleased]`, so the unreleased entries become this release's
   section. CI fails the commit when the newest section does not name the
   `package.json` version (`tests/workflow-release.test.ts`).
3. Add a migration note if the release needs one (see
   [CONTRIBUTING](https://github.com/itlackey/akm/blob/main/.github/CONTRIBUTING.md#shipping-a-release--migration-notes)).
4. Commit `release: <version>`, push it to the release branch, and dispatch:

   ```sh
   gh workflow run release.yml --ref release/<cut date> -f stage=beta
   ```

The Release workflow, on that commit:

1. runs CI (lint, the typecheck, the unit and integration suites, the build, the
   Node fallback smoke, Desktop's tests) and Gated CI (semantic search with
   real embeddings, the Docker install matrix, the native schedulers on Linux,
   macOS and Windows) as its own jobs;
2. runs `tests/release-check.sh --skip-docker`: the packaged artifact's bin
   targets and migrator, and package acceptance;
3. builds the package and the standalone binaries;
4. publishes `<version>-<stage>` to npm `next` and creates a GitHub prerelease;
5. builds AKM Desktop on Linux, macOS and Windows from the tarball it just
   published and attaches the installers to the same release (Desktop shares
   the akm version, tag and changelog, and its beta channel follows GitHub
   prereleases; the installers are unsigned, see
   [Software](https://github.com/itlackey/akm/blob/main/desktop/docs/software.md#unsigned-installers));
6. publishes `akm-web` (Desktop's web process alone, for servers and
   containers) from the same tarball.

The stage is `alpha`, `beta` or `rc`. Every prerelease takes the next number;
a build is not promoted through stages.

## 3. Ship a stable release

On the release branch:

1. Set the version and cut the changelog as above, commit `release: <version>`,
   push.
2. Open the release pull request:

   ```sh
   gh pr create --base main --head release/<cut date> --title "release: <version>"
   ```

   This pull request is the whole gate: everything a pull request runs, plus
   Desktop packaged on all three platforms, the upgrade rehearsals from the
   previous stable and from the oldest supported releases, Gated CI, and the
   check that the head is a release branch. Fix on the release branch until it
   is green. Rerun failed jobs on a flake.
3. Merge it (a merge commit, so `main` carries the branch's commits). The push
   to `main` runs the Release workflow, which publishes the committed version to
   npm `latest`, creates the GitHub release with the binaries, the installers
   and `checksums.txt`, builds and attaches Desktop, and publishes `akm-web`.
   Nothing is tested again: the pull request proved this tree, and the ruleset
   requires the branch to be up to date, so the merge has the same tree.
4. Cut the next release branch ([section 1](#1-cut-a-release-branch)).

If Release fails on a flake, rerun the failed jobs: a rerun on the same commit
skips what is already published. If the version it would publish is already
released from another commit (a merge into `main` without a new version), it
stops before building anything. A fix that needs a code change is the next
release; the failed number stays unused.

To rehearse the packaging without publishing anything, dispatch a dry run on
any branch. It skips the gates, the npm publish and the GitHub release, builds
the package, the binaries and Desktop on all three platforms, and keeps the
files as workflow artifacts of the run (`akm-cli`, `desktop-<os>`); nothing is
tagged:

```sh
gh workflow run release.yml --ref <branch> -f dry_run=true
```

npm can take several minutes to show a new version: check
`npm view akm-cli@<tag> version` before upgrading.

### akm-web the first time

The `akm-web` job fails on every release until the package exists on npm and
has a trusted publisher. Once, by hand, from a clean checkout of the release
commit, logged in to npm:

```sh
cd desktop
node scripts/core.mjs --tarball /path/to/akm-cli-<version>.tgz   # the released tarball
bun install --frozen-lockfile --ignore-scripts --force
npm run build
node scripts/package-web.mjs --release                            # prints {"stage": "<dir>"}
npm publish <dir> --ignore-scripts --access public --tag next     # `latest` for a stable version
```

Then on npmjs.com add a trusted publisher for `akm-web`: repository `itlackey/akm`, workflow `release.yml`, and
leave the Environment field blank (the `akm-web` job has no environment; the `release` job's `release`
environment would not match).

## 4. Release the plugins

```sh
gh workflow run release.yml --repo itlackey/akm-plugins --ref <plugins branch> -f akm_version=<published akm version>
```

Plugins match akm's major.minor and keep their own patch numbers; each plugin
release's notes name the akm version it requires. A plugin-only fix is released
the same way, with the akm version already published. The Claude marketplace
reads the plugins repository's `main`, so stable plugin releases come from
`main`.

## 5. Upgrade

`akm upgrade` (stable) or `akm upgrade --next` (prerelease) updates akm and the
installed plugins.

## Gated CI on its own

Gated CI also runs weekly on the default branch, the open release branch, to
catch drift, and on demand from the Actions tab on any ref. Only the weekly run
saves the Hugging Face model cache.

## Versions

0.10 and later use monthly release numbers, `0.10.YYMMNN`: `YY` the UTC year,
`MM` the month and `NN` the release in that month (`01` to `99`), two digits
each (see [`STABILITY.md`](../../STABILITY.md)). `bun scripts/release-version.ts
next` takes `NN` as one above the highest release already on npm for this UTC
month, with or without a stage, and `bun scripts/release-version.ts validate
<version>` checks one by hand. The retired 8-digit daily builds
(`0.10.26101001-alpha` to `0.10.26101202-alpha`) are not counted. 0.9 and older
use `X.Y.Z`.

The stage is not committed: a push to `main` publishes the committed
`<version>` to `latest`; a dispatch with `alpha`, `beta` or `rc` publishes
`<version>-<stage>` to `next` as a GitHub prerelease. Every release, at any
stage, takes the next number; a build is not promoted through stages. A number
that never published (an abandoned branch, a failed release) is not reused.

## Repository settings

The process is enforced by the repository's settings where GitHub allows it.
Set these once; the cut step changes only the default branch.

**Default branch.** The open release branch. `gh repo edit --default-branch
release/<cut date>` at each cut. Pull requests, `gh pr create` and the weekly
schedule follow it.

**Ruleset `main`** (Settings → Rules → Rulesets; rulesets are the current form
of branch protection and are available on a public repository under the Free
plan). Target branch `main`, enforcement active, no bypass list:

- Restrict deletions. Block force pushes.
- Require a pull request before merging; allowed merge method: merge commit
  only, so `main` carries the release branch's commits and the next cut
  descends from them.
- Require status checks to pass, with "Require branches to be up to date
  before merging" on. The required checks, as CI names them (a check must have
  run once before it can be selected):
  `check`, `release-branch-only`, `desktop`, `node-smoke (22)`,
  `node-smoke (24)`, `desktop-package (ubuntu-latest)`,
  `desktop-package (macos-latest)`, `desktop-package (windows-latest)`,
  `upgrade-rehearsal (previous)`, `upgrade-rehearsal (0.9.32)`,
  `upgrade-rehearsal (0.9.15)`, `gated / Gated / Semantic Search`,
  `gated / Gated / Docker Install`, `gated / Gated / Native Scheduler / Linux`,
  `gated / Gated / Native Scheduler / macOS`,
  `gated / Gated / Native Scheduler / Windows`.

Rulesets cannot restrict which branch a pull request comes from; the
`release-branch-only` check does that, and requiring it makes a pull request
from any other branch unmergeable into `main`.

**Ruleset `release/*`.** Target `release/*`: block force pushes. Direct pushes
stay allowed, for the `release: <version>` commit; everything else arrives by
pull request, which the `check` job gates.

**Pull requests** (Settings → General): allow merge commits (release pull
requests need them; squash and rebase may stay on for pull requests into the
release branch); automatically delete head branches, so a merged release branch
and merged feature branches go away on their own.

**Environment `release`** (Settings → Environments): deployment branches and
tags limited to `main` and `release/*`, so a dispatch from any other branch
cannot publish. A required reviewer is available here if a manual approval is
ever wanted; the release pull request is the approval today.

**Actions** (Settings → Actions → General): workflow permissions read-only;
each workflow declares what it needs.

**npm trusted publishers** (npmjs.com, `akm-cli` and `akm-web`): repository
`itlackey/akm`, workflow `release.yml`; environment `release` for `akm-cli`,
blank for `akm-web`. Unchanged by the branch model.
