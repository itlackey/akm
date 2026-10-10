# Release Checklist

Use this checklist for every release candidate. Local release validation and
scheduled CI are useful inputs, but neither substitutes for a successful gated
run of the exact commit that will be published.

## 1. Freeze the candidate

1. Finish the changelog, migration-note, and release-PR changes. From 0.10 the
   version is not committed: the Release workflow numbers the build when it runs
   (see step 4), so `package.json` on a 0.10 release branch only names the line
   (`0.10.0`) and the CHANGELOG heading is the published version, added when the
   build is published.
2. Record `git rev-parse HEAD`. This is the full 40-character release-candidate SHA.
3. Run `bun run release:check` locally. If Docker is unavailable, run
   `./tests/release-check.sh --skip-docker` and rely on the gated Docker job
   below for the container matrix.

Any commit added after this point creates a new candidate and invalidates the
gated evidence collected for the previous SHA.

## 2. Collect exact-SHA gated evidence

GitHub only offers a scheduled or manually dispatched workflow after its file
exists on the default branch. When validating the commit that first introduces
or changes this workflow, create a unique lightweight candidate tag at the
recorded SHA:

```sh
candidate_sha="$(git rev-parse HEAD)"
candidate_short_sha="$(git rev-parse --short=12 HEAD)"
candidate_version="$(node -p 'require("./package.json").version')"
candidate_tag="gated-ci/candidate-${candidate_version}-${candidate_short_sha}"
git tag "$candidate_tag" "$candidate_sha"
git push origin "refs/tags/$candidate_tag"
```

Verify that the tag target is the exact candidate commit recorded in step 1.
The `gated-ci/candidate-*` trigger runs every gated suite from the workflow in
that tagged commit. The resolver checks that the checkout equals the immutable
event SHA, and the final evidence job records both that SHA and the tag ref.
Never force-move or reuse a candidate tag; a changed commit needs a new tag and
a new run.

After **Gated CI** exists on the default branch, manual dispatch is an
equivalent exact-SHA path. From the repository's Actions page, choose **Run
workflow** and supply:

- `candidate_sha`: the full 40-character SHA recorded above, never a branch or
  tag name.

Every suite runs; there is no suite selector.

The manual request rejects abbreviated SHAs and checks out that immutable
commit for every gate. Wait for all of these stable checks to succeed on either
candidate path:

- `Gated / Semantic Search`
- `Gated / Docker Install`
- `Gated / Native Scheduler / Linux`
- `Gated / Native Scheduler / macOS`
- `Gated / Native Scheduler / Windows`
- `Gated / Release Candidate Evidence`

The final evidence job records the requested and resolved SHA, the trigger ref,
each suite's result, and a run link in the workflow summary. A weekly run is
drift detection, not release evidence, because it may cover a different
commit.

Manual and tagged candidate runs are cache restore-only. Only a successful
scheduled run of the workflow on the repository's default branch may save the
HuggingFace model cache; its key identifies both the embedding model and the
source/lock inputs. This prevents candidate-controlled workflow code from
publishing cache entries while still avoiding repeated model downloads.

Copy the successful run URL (for example,
`https://github.com/itlackey/akm/actions/runs/<run-id>`) and the exact candidate
SHA into both the release PR and its milestone/parent tracker. Do not publish
from a candidate whose evidence link names a different SHA, whose final
evidence job is skipped, or whose run was re-run after the candidate changed.

## 3. Gated CI does not run on pull requests

Gated CI runs on three triggers only: the weekly schedule, an exact-SHA
`workflow_dispatch`, and a `gated-ci/candidate-*` tag. All three run every
suite.

There used to be a `Gated / Detect Changed Paths` job that also ran these on
PRs, selecting suites by regex-matching the diff against path lists. It was
deleted in 0.9.8: the patterns had gone stale — they still named test files a
reorganisation had moved or deleted, so it was silently under-selecting suites
and nobody noticed. A build-policing job that quietly stops policing is worse
than no job, because its green status is read as coverage.

Nothing about release evidence changes. Step 2 was always the requirement, and
it never went through the PR path.

The candidate-tag trigger is reserved for release evidence and workflow
rollout: it always runs `all`, because a tag-push workflow is the path available
before the workflow file reaches the default branch.

## 4. Publish

After the exact-SHA gated run and local release check are green, trigger the
Release workflow. Keep the candidate SHA and Gated CI run URL in the release
record so the published artifact's validation can be audited later.

0.10 and later use daily builds, `0.10.YYMMDDNN` (`YY` UTC year, `MM` month,
`DD` day, `NN` the build that day, `01` to `99`; see
[`STABILITY.md`](../../STABILITY.md)). The workflow has two inputs:

- `version`: leave it empty to publish the next build of today (UTC). The
  workflow takes `NN` as one above the highest build already on npm that day
  (`npm view akm-cli versions`), so the first build on 2026-10-10 is
  `0.10.26101001` and the next is `0.10.26101002`. To promote a build, enter its
  number (`0.10.26101001`). It stamps the version into the run's `package.json`.
  For 0.9 and older, enter the `X.Y.Z` already committed in `package.json`, as
  before.
- `stage`: `none` publishes the stable build to the npm `latest` tag and a
  non-prerelease GitHub release. `alpha`, `beta` or `rc` appends `-<stage>` and
  publishes to `next` as a GitHub prerelease. One build goes through the stages
  by running the workflow again with its number and the next stage, then with
  `none`.

`scripts/release-version.ts` does the validation and numbering (tested in
`tests/release-version.test.ts`): `bun scripts/release-version.ts validate
<version>` checks a version by hand. The workflow rejects a malformed version
(two digits each for `YY`, `MM`, `DD`, `NN`; a real calendar date; `NN` 01 to 99;
stage only `alpha`, `beta` or `rc`, with no `.N`). Add the CHANGELOG heading
`## [0.10.YYMMDDNN] - YYYY-MM-DD` for the published stable build.
