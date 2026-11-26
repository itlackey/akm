# Release Checklist

## Branch model

1. `main` is the stable line. The only thing that merges into `main` is a
   release branch, by pull request. Every commit on `main` is a release: tagged
   `v<version>`, on npm `latest`, with a GitHub release that carries the
   binaries, the installers and AKM Desktop.
2. A release branch, `release/<version>`, is cut from `main` with the next
   version of its line ([Versions](#versions)). Pull requests name it as their
   base (`gh pr create --base release/<version>`); `main` stays the default
   branch, and a pull request into `main` from anything but a release branch
   cannot merge. The first 0.11 branch was never merged with `main` and was
   deleted; its commits are kept as the tag `archive/release-0.11.0`. 0.11
   restarts from `main` and reapplies its removals.
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
bun run release:start          # the next version of main's line
bun run release:start 0.11     # the first version of the next minor
```

It creates `release/<version>` from `origin/main` with the next version of
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

1. runs CI (lint, the typecheck, the unit suite, the architecture checks, the
   build, Desktop's check and build), the integration suite, Desktop's tests, the
   Node fallback smoke on Node 22 and 24, the upgrade rehearsals from the previous stable and from the
   oldest supported releases, and Gated CI (semantic search with real
   embeddings, the Docker install matrix, the native schedulers on Linux, macOS
   and Windows) as its own jobs. The integration suite, the Node fallback
   smoke, the upgrade rehearsals, Desktop's tests and Gated CI run only for a
   release: on a prerelease dispatch, on the release pull request into `main`,
   and on the push to `main` when the merged tree has not already passed them;
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

   That pull request runs everything a pull request runs, plus Desktop
   packaged on all three platforms, the check that the head is a release
   branch whose version package.json carries, and the release gates, as jobs
   of the Release workflow: the integration suite, the Node fallback smoke,
   the upgrade rehearsals, Desktop's tests and Gated CI. They are required
   checks on `main`, so a stable cannot merge red. They run only on a pull
   request that is ready and comes from a `release/*` branch; nothing else
   runs them, and the Release workflow builds, tags and publishes nothing on a
   pull request. Fix on the release branch until it is green. Rerun failed jobs
   on a flake.
3. Merge it (a merge commit, so `main` carries the branch's commits). The push
   to `main` runs the Release workflow. Its `proven` job finds the merged pull
   request and compares trees: the ruleset requires the branch to be up to
   date, so the merge commit has the pull request head's tree, and when that
   head's own Release run passed the gates, the push skips them. If it finds no
   such run, the gates run on the merged commit as for a dispatch. Then it
   publishes `<version>` to npm `latest`, creates the GitHub release with the
   binaries, the installers and `checksums.txt`, builds and attaches Desktop,
   and publishes `akm-web`. CI is not run again. A failed gate stops the
   release before anything is published.
4. Cut the next release branch ([section 1](#1-cut-a-release-branch)).

If Release fails on a flake, rerun the failed jobs: a rerun on the same commit
skips what is already published. A fix that needs a code change is the next
release.

If a gate fails after the merge (the push re-ran them because no passing run
of that tree was found, or a gate flaked past a rerun), `main` holds the merged
release and nothing is published. Cut a new release branch from `main`
([section 1](#1-cut-a-release-branch)), fix there, ship it as a stable
([section 3](#3-ship-a-stable-release)): its pull request runs the gates, the
merge re-runs Release, and the new version is published (the failed version
number stays unused).

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

Plugins match akm's major.minor and keep their own patch numbers; each plugin
release's notes name the akm version it requires. A plugin-only fix is released
the same way, with the akm version already published. The Claude marketplace
reads the plugins repository's `main`, so stable plugin releases come from
`main`.

A plugin release that reads a new `config.json` key, under `plugins` or
anywhere else, waits for a published akm release whose config schema declares
that key, and requires that version. `akm migrate apply` deletes every key the
schema does not declare, and hosts run it at startup (#1613). Before releasing
the plugin, set the key, run the published CLI's `akm migrate apply` twice, and
check the key is still there.

## 5. Upgrade

`akm upgrade` (stable) or `akm upgrade --channel next` (prerelease) updates akm and the
installed plugins.

## Gated CI on its own

Gated CI runs from the Release workflow on every release (on the release pull
request, and again on the push to `main` only if the tree has not already
passed), and on demand from the Actions tab on any ref (`workflow_dispatch`).
Only a run on the push to `main` saves the Hugging Face model and ONNX Runtime
caches, so they are saved only when that push runs Gated CI.

## Versions

The scheme depends on the line's minor ([`STABILITY.md`](../../STABILITY.md)).
A 0.10 release is `0.10.YYMMNN`, its number taken when its branch is cut. From
0.11 releases are plain semver: the stable release is `0.11.0`, then patches
`0.11.1`, `0.11.2`; the next minor starts at `0.12.0`. In both, the branch is
`release/<version>` and prereleases are that version with `-alpha.N`, `-beta.N`
or `-rc.N` appended (`0.11.0-beta.1`). `bun scripts/release-version.ts next
[0.<minor>]` prints the next version of a line from the versions on npm: the
next free monthly number for 0.10 (the retired 8-digit daily builds are not
counted), one patch above the line's latest stable, or `0.<minor>.0`, from
0.11. `validate <version>` checks one by hand, and the Release workflow
appends the stage and the next counter at publish time; the stage is never
committed. A version that never published (an abandoned branch) stays unused.
A stable of an older line published after a newer line's does not take GitHub's
Latest release.

`bun run release:start 0.11` cuts `release/0.11.0`. The earlier 0.11 branch of
that name is archived as the tag `archive/release-0.11.0`
([Branch model](#branch-model)).

## Repository settings

The process is enforced by the repository's settings where GitHub allows it.
`bun scripts/github-settings.ts` applies everything in this section through
`gh api` (logged in with admin rights; `--dry-run` prints the requests). It
reads the required checks from the workflow files (`ci.yml`, and the gate jobs
of `release.yml` listed in the script's `RELEASE_GATES`), so run it again after
a CI or gate matrix change, a new gate job, or after a check moves between
workflows (the release gates became required on `main` when they began running
on the release pull request: run it once before the next release pull request,
or `main` does not require them). `main` stays the default branch.

**Ruleset `main`** (Settings → Rules → Rulesets; rulesets are the current form
of branch protection and are available on a public repository under the Free
plan). Target branch `main`, enforcement active, no bypass list:

- Restrict deletions. Block force pushes.
- Require a pull request before merging; allowed merge method: merge commit
  only, so `main` carries the release branch's commits and the next cut
  descends from them.
- Require status checks to pass, with "Require branches to be up to date
  before merging" on. Require every check a release pull request reports: the
  CI jobs (`check`, `release-branch-only`, `desktop`, each `desktop-package`
  matrix entry, `plugins-contract`) and the Release workflow's gates:
  `integration`, each `node-smoke` and `upgrade-rehearsal` matrix entry,
  `desktop-tests`, `desktop-e2e`, `desktop-usability`, and Gated CI's jobs
  (`gated / Gated / Semantic Search`, `gated / Gated / Docker Install`,
  `gated / Gated / Native Scheduler / <platform>`). A required check that is
  skipped counts as passing, which is why a draft pull request, which cannot
  merge, runs none of them.

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

The 0.11 upgrade gate must preserve the `cli_usage_*` tables of `metrics.db` (instance
identity and durable aggregates) instead of rebuilding them;
`bun test tests/integration/cli-usage.test.ts` covers the tables.
