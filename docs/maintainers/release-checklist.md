# Release Checklist

## Branch model

1. `main` is the stable line. The only thing that merges into `main` is a
   release branch, by pull request. Every commit on `main` is a release: tagged
   `v<version>`, on npm `latest`, with a GitHub release that carries the
   binaries, the installers and AKM Desktop.
2. A release branch, `release/<version>`, is cut from `main` with the next free
   number of its line ([Versions](#versions)). Pull requests name it as their
   base (`gh pr create --base release/<version>`); `main` stays the default
   branch, and a pull request into `main` from anything but a release branch
   cannot merge. A branch for the next minor can be open at the same time,
   `release/0.11.261101` beside `release/0.10.261121`. The patch ships first,
   and the 0.11 branch merges `main` before it can ship (the ruleset requires
   it), so the patch is in 0.11 too.
3. All work lands on the release branch by pull request. A feature that needs
   several pull requests lands in slices that are each shippable but inert
   until the last one (internals first, the command or flag wired up last, or
   marked Experimental in [`STABILITY.md`](../../STABILITY.md)), or on a feature
   branch off the release branch, with pull requests into it and one pull
   request from it into the release branch. A pull request that depends on
   another sets that pull request's branch as its base; GitHub retargets it
   when the first one merges.
4. A prerelease is a dispatch of the Release workflow on the release branch
   with a stage. It publishes `<version>-<stage>.N` to npm `next`, `N`
   counting up from 1 for that stage, as often as needed.
5. To ship, commit `release: <version>` (package.json and the changelog cut),
   open the pull request into `main` and merge it when green. The push to
   `main` publishes `<version>` to npm `latest`. The branch is deleted.
6. Cut the next release branch from `main`.

Each step is one command: `bun run release:start [0.<minor>]`, `bun run
release:prerelease [alpha|beta|rc]` and `bun run release:stable`
(`scripts/release.sh`). Each refuses to run from the wrong branch or with
unpushed changes, and says why.

The release branch is always shippable: a pull request merges when the branch
would still ship with it in. A feature that is not ready waits in its pull
request, not the release. A bug in stable is fixed in the next release; a change
that turns out wrong is reverted on the release branch. While the release
branch's pull request into `main` is open, nothing else merges into the release
branch.

## 1. Cut a release branch

From a clean tree on any branch:

```sh
bun run release:start          # the next number of main's line
bun run release:start 0.11     # the first number of the next minor
```

It creates `release/<version>` from `origin/main` with the next free number of
the line (`bun scripts/release-version.ts next [0.<minor>]`) and pushes it.
GitHub deletes the branch when its pull request into `main` merges (see
[Repository settings](#repository-settings)).

## 2. Prerelease

When the branch is worth trying before it ships, on the release branch with
everything pushed:

```sh
bun run release:prerelease          # beta
bun run release:prerelease rc       # alpha, beta or rc
```

No commit is needed: the branch name carries the version. It dispatches the
Release workflow on the branch (`gh workflow run release.yml --ref
release/<version> -f stage=<stage>`), which, on the branch's head:

1. runs CI (lint, the typecheck, the unit and integration suites, the build, the
   Node fallback smoke, Desktop's tests) and Gated CI (semantic search with
   real embeddings, the Docker install matrix, the native schedulers on Linux,
   macOS and Windows) as its own jobs;
2. runs `tests/release-check.sh --skip-docker`: the packaged artifact's bin
   targets and migrator, and package acceptance;
3. builds the package and the standalone binaries as `<version>-<stage>.N`,
   `N` one above the highest already on npm for that release and stage;
4. publishes them to npm `next` (or to the line's tag, `next-0.10`, when a
   newer line's prerelease already holds `next`) and creates a GitHub
   prerelease;
5. builds AKM Desktop on Linux, macOS and Windows from the tarball it just
   published and attaches the installers to the same release (Desktop shares
   the akm version, tag and changelog, and its beta channel follows GitHub
   prereleases; the installers are unsigned, see
   [Software](https://github.com/itlackey/akm/blob/main/desktop/docs/software.md#unsigned-installers));
6. publishes `akm-web` (Desktop's web process alone, for servers and
   containers) from the same tarball.

Repeat as often as the branch needs; each dispatch takes the next counter.

## 3. Ship a stable release

On the release branch with everything pushed:

1. Add a migration note if the release needs one (see
   [CONTRIBUTING](https://github.com/itlackey/akm/blob/main/.github/CONTRIBUTING.md#shipping-a-release--migration-notes)),
   and merge it like any other change.
2. Run:

   ```sh
   bun run release:stable
   ```

   It sets package.json to the branch's version, cuts the changelog (the
   `## [Unreleased]` entries become `## [<version>] - <UTC date>` under a fresh
   empty Unreleased heading; `tests/workflow-release.test.ts` pins the two
   against each other), commits `release: <version>`, pushes, and opens the
   pull request into `main` (`gh pr create --base main`). The pull request can
   be opened earlier as a draft (`gh pr create --base main --draft`): CI runs
   nothing on a draft into `main`, and `release:stable` marks it ready, which
   runs the whole gate once on the release commit.

   That pull request is the whole gate: everything a pull request runs, plus
   Desktop packaged on all three platforms, the upgrade rehearsals from the
   previous stable and from the oldest supported releases, Gated CI, and the
   check that the head is a release branch whose version package.json carries.
   Fix on the release branch until it is green. Rerun failed jobs on a flake.
3. Merge it (a merge commit, so `main` carries the branch's commits). The push
   to `main` runs the Release workflow, which publishes `<version>` to npm
   `latest`, creates the GitHub release with the binaries, the installers and
   `checksums.txt`, builds and attaches Desktop, and publishes `akm-web`.
   Nothing is tested again: the pull request proved this tree, and the ruleset
   requires the branch to be up to date, so the merge has the same tree.
4. Cut the next release branch ([section 1](#1-cut-a-release-branch)).

If Release fails on a flake, rerun the failed jobs: a rerun on the same commit
skips what is already published. A fix that needs a code change is the next
release.

To rehearse the packaging without publishing anything, dispatch a dry run on
the release branch. It skips the gates, the npm publish and the GitHub release,
builds the package, the binaries and Desktop on all three platforms, and keeps
the files as workflow artifacts of the run (`akm-cli`, `desktop-<os>`); nothing
is tagged:

```sh
gh workflow run release.yml --ref release/<version> -f dry_run=true
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

From 0.11 on, release the plugins after every akm release, prereleases
included, with `akm_version` set to that release. The plugins run the akm-cli
they carry, so a host's plugins use that older akm until a plugin release
carries the new one. A prerelease `akm_version` makes a `next` plugin release,
which sets the pins itself; for a stable one, first move the `akm-cli` pins on
the plugins' `main` to it.

Plugins match akm's major.minor and keep their own patch numbers; each plugin
release's notes name the akm version it requires. A plugin-only fix is released
the same way, with the akm version already published. The Claude marketplace
reads the plugins repository's `main`, so stable plugin releases come from
`main`.

## 5. Upgrade

`akm upgrade` (stable) or `akm upgrade --next` (prerelease) updates akm and the
installed plugins.

## Gated CI on its own

Gated CI also runs weekly on `main` to catch drift, and on demand from the
Actions tab on any ref. Only the weekly run saves the Hugging Face model cache.

## Versions

The scheme is in [`STABILITY.md`](../../STABILITY.md): `0.<minor>.YYMMNN`, a
release's number taken when its branch is cut, its prereleases that number with
the stage and a counter appended. `bun scripts/release-version.ts next
[0.<minor>]` prints the next free number of a line from the versions on npm
(the retired 8-digit daily builds are not counted), `validate <version>`
checks one by hand, and the Release workflow appends the stage and the next
counter at publish time; the stage is never committed. A number that never
published (an abandoned branch) stays unused.

## Repository settings

The process is enforced by the repository's settings where GitHub allows it.
`bun scripts/github-settings.ts` applies everything in this section through
`gh api` (logged in with admin rights; `--dry-run` prints the requests). It
reads the required checks from the workflow files, so run it again after a CI
matrix change. `main` stays the default branch.

**Ruleset `main`** (Settings → Rules → Rulesets; rulesets are the current form
of branch protection and are available on a public repository under the Free
plan). Target branch `main`, enforcement active, no bypass list:

- Restrict deletions. Block force pushes.
- Require a pull request before merging; allowed merge method: merge commit
  only, so `main` carries the release branch's commits and the next cut
  descends from them.
- Require status checks to pass, with "Require branches to be up to date
  before merging" on. Require every check a release pull request reports: the
  CI jobs (`check`, `release-branch-only`, `desktop`, and each `node-smoke`,
  `desktop-package` and `upgrade-rehearsal` matrix entry) and the five Gated CI
  jobs. GitHub lists them by name once the first release pull request has run.

Rulesets cannot restrict which branch a pull request comes from; the
`release-branch-only` check does that, and also checks that package.json
carries the branch's version. Requiring it makes a pull request from any other
branch, or one without its release commit, unmergeable into `main`.

**Ruleset `release/*`.** Target `release/*`: block force pushes. Direct pushes
stay allowed, for the `release: <version>` commit; everything else arrives by
pull request, which the `check` job gates.

**Pull requests** (Settings → General): allow merge commits (release pull
requests need them; squash and rebase may stay on for pull requests into the
release branch); automatically delete head branches, so merged feature branches
and merged release branches go away on their own.

**Environment `release`** (Settings → Environments): deployment branches and
tags limited to `main` and `release/*`, so a dispatch from any other branch
cannot publish. A required reviewer is available here if a manual approval is
ever wanted; the release pull request is the approval today.

**Actions** (Settings → Actions → General): workflow permissions read-only;
each workflow declares what it needs.

**npm trusted publishers** (npmjs.com, `akm-cli` and `akm-web`): repository
`itlackey/akm`, workflow `release.yml`; environment `release` for `akm-cli`,
blank for `akm-web`. Unchanged by the branch model.
