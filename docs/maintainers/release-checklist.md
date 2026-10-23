# Release Checklist

`main` is the stable line (npm `latest`). The next version is developed on a
release branch, `release/<version>` (npm `next`), which merges to `main` when
it becomes stable. A fix for stable lands on `main` and is cherry-picked onto
the release branch when that branch needs it.

## 1. Cut the version

On the branch you release from (`main` for stable, the release branch for
next):

1. Set the version: `npm pkg set version=<version>`.
2. Cut the changelog: add `## [<version>] - <YYYY-MM-DD>` (UTC date) directly
   under `## [Unreleased]`, so the unreleased entries become this release's
   section. CI fails the release commit when the newest section does not name
   the `package.json` version (`tests/workflow-release.test.ts`).
3. Add a migration note if the release needs one (see
   [CONTRIBUTING](https://github.com/itlackey/akm/blob/main/.github/CONTRIBUTING.md#shipping-a-release--migration-notes)).
4. Commit `release: <version>`, push it to the branch, and let CI run on it.

## 2. Release akm

```sh
gh workflow run release.yml --ref <branch> -f version=<version>
```

The Release workflow, on the pushed commit:

1. runs Gated CI: semantic search with real embeddings, the Docker install
   matrix, and the native schedulers on Linux, macOS and Windows;
2. requires CI to have passed on the same commit (it does not run lint, the
   typecheck or the test suites again);
3. runs `tests/release-check.sh --skip-docker`: the packaged artifact's bin
   targets and migrator, package acceptance, and the upgrade rehearsal against
   the packed tarball;
4. builds the package and standalone binaries, publishes to npm (`latest` for
   a stable version, `next` for a prerelease) and creates the GitHub release.

If a job fails on a flake, rerun the failed jobs. If the fix needs a code
change, commit it and release that commit. npm can take several minutes to show
a new version: check `npm view akm-cli@<tag> version` before upgrading.

## 3. Release the plugins

```sh
gh workflow run release.yml --repo itlackey/akm-plugins --ref <plugins branch> -f akm_version=<published akm version>
```

Plugins match akm's major.minor and keep their own patch numbers; each plugin
release's notes name the akm version it requires. A plugin-only fix is released
the same way, with the akm version already published. The Claude marketplace
reads the plugins repository's `main`, so stable plugin releases come from
`main`.

## 4. Upgrade

`akm upgrade` (stable) or `akm upgrade --next` (prerelease) updates akm and the
installed plugins.

## Gated CI on its own

Gated CI also runs weekly on `main` to catch drift, and on demand from the
Actions tab on any ref. Only the weekly run saves the Hugging Face model cache.
