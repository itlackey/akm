# Commands and results

Run date: 2026-10-20 America/Chicago (saved runner artifacts use 2026-10-21 UTC).
No production publication was performed. Paths below are the actual local paths;
replace them with equivalent checkouts when reproducing. Keep the owner's private
embedding overlay/credential setup private; the saved summaries show its effective
redacted parameters. `LAB_API_KEY` was inherited symbolically, never printed.

## Preparation

```sh
cd /home/founder3/code/github/itlackey/akm-stash
git status --short
git pull --ff-only origin main
# clean; 5ee979e -> fd61fd1
cd /home/founder3/code/github/itlackey/akm
git fetch origin
# release/0.10.0 -> 79cf3236a
```

The managed worktree tool created
`/home/founder3/.codex/worktrees/1199-curate-recall-controls/akm` from
`origin/release/0.10.0`. In it:

```sh
git switch -c feat/1199-curate-recall-controls
bun install
```

The clean cached akm-stash skill checkout was also refreshed with
`git pull --ff-only origin main` (already current). Read the current SKILL.md,
Retrieval and answers section, evaluation guide and definition of done; AKM's
AGENTS.md, architecture and API contracts; issue #1199 and merged prerequisite
fixtures. Baseline source was frozen with `git archive 79cf3236a` into
`/tmp/akm-1199-baseline`, using the candidate's Bun dependencies.

## Retrieval collection

Selected evaluator: `/tmp/akm-eval-1199`, revision `27f5240`, with the saved
`collector-adaptation.patch` and private lab embedding overlay. The existing
per-query argv fixture field is reused for search **and curate**. Constants:

```sh
BASE='bun /tmp/akm-1199-baseline/src/cli.ts'
CAND='bun /home/founder3/.codex/worktrees/1199-curate-recall-controls/akm/src/cli.ts'
cd /tmp/akm-eval-1199
scripts/smoke/run --contract --only retrieval --akm "$BASE"
# 1 run, 1 outcome reached, 0 skipped
python3 /tmp/1199-corpus.py /tmp/1199-recall-cases
evals/retrieval/run --cases /tmp/1199-recall-cases --semantic --limit 4 --label 1199-baseline-pilot --akm "$BASE"
evals/retrieval/run --cases /tmp/1199-recall-cases --semantic --label 1199-baseline --akm "$BASE"
evals/retrieval/run --cases /tmp/1199-recall-cases --semantic --limit 4 --label 1199-candidate-pilot --akm "$CAND"
evals/retrieval/run --cases /tmp/1199-recall-cases --semantic --label 1199-candidate --akm "$CAND"
evals/retrieval/run --semantic --label 1199-public-baseline --akm "$BASE"
evals/retrieval/run --semantic --label 1199-public-matched --akm 'bun /tmp/1199-matched.ts'
evals/retrieval/run --semantic --label 1199-public-current --akm 'bun /tmp/1199-search-current.ts'
python3 /home/founder3/.codex/worktrees/1199-curate-recall-controls/akm/docs/evaluations/1198/make-corpus.py /tmp/1199-public-eligibility
evals/retrieval/run --cases /tmp/1199-public-eligibility --semantic --label 1199-eligibility --akm "$CAND"
```

Eight valid collector invocations; two additional invalid invocations stayed
within the 12-run budget: this evaluator rejects `--semantic on` (it accepts a
boolean flag), and an overlapping same-corpus pilot was refused by its index
lock. Both were fixed before collecting usable results. No fourth variant or
extra quality-tuning collection was used. Full public runs were sequential.
An approval review initially rejected uploading the reused temporary eligibility
fixture because its provenance was unclear. Regenerating it solely from the
committed public synthetic generator and verifying byte equality established
that no private corpus was involved; the subsequent run was approved.

The public wrappers saved here make their treatment explicit: matched sets
candidate curate `--belief all`; current sets search `--belief current` (before
variant 2 made that the actual default). The final installed check separately
uses the actual product default without either wrapper. Baseline unsupported
curate flags produce the documented usage errors; they are not scored as empty
correct answers.

## Judgment, variation and comparisons

Reviewed newly surfaced task pairs, preserved all earlier labels, saved 63 missing
judgments, and rescored all baseline/matched/current public saved outputs:

```sh
scripts/rescore/run \
 evals/retrieval/results/2026-10-21-1199-public-baseline-library \
 evals/retrieval/results/2026-10-21-1199-public-matched-library \
 evals/retrieval/results/2026-10-21-1199-public-current-library \
 evals/retrieval/results/2026-10-21-1199-public-baseline-books \
 evals/retrieval/results/2026-10-21-1199-public-matched-books \
 evals/retrieval/results/2026-10-21-1199-public-current-books
# all 6 rescored successfully, originals retained
```

For each `library` / `books`, used `scripts/compare/run` on corresponding
`baseline-<collection>-rescored` and `matched-` / `current-` folders, saving the
JSON/Markdown reports. Compact runs used the same compare command on the saved
`1199-baseline-own` / `1199-candidate-own` directories. Read their denominator
warnings: baseline curate has ten unsupported cases.

`bun /tmp/1199-variation.ts` used the existing sandbox/ask helpers for five
preselected negative-delta cases, twice per build on one isolated copied semantic
index: 40 valid calls, zero errors; scored with existing `scoreQuery`. A previous
40-call attempt raced a rebuild (three errors) and was excluded. There was no
quality tuning from the repeat. `bun /tmp/1199-defaults.ts` measured three actual
CLI default observations per build/job and packed payload cost, explicitly omitting
product mode/timeout/reranker/recall defaults. Results and limits are in the record.

## AKM checks and installed package

```sh
bun test tests/integration/search-candidate-eligibility.test.ts tests/integration/parent-eligibility-final.test.ts tests/integration/api/curate-api.test.ts
# baseline: 48 pass, 0 fail
bun test tests/integration/search-candidate-eligibility.test.ts tests/integration/parent-eligibility-final.test.ts tests/integration/extract-evidence.test.ts tests/curate-rerank.test.ts tests/curate-pack.test.ts tests/curate-logic.test.ts tests/integration/api/curate-api.test.ts tests/integration/curate-recall-controls.test.ts
# combined candidate: 97 pass, 0 fail
bun test tests/integration/curate-recall-controls.test.ts tests/integration/parent-eligibility-final.test.ts tests/integration/extract-evidence.test.ts
# final reserved checks: 35 pass, 0 fail
bunx biome check --write src/ tests/
bun run check
# final: lint + tsc pass; unit 7213 pass, 4 skip, 0 fail;
# integration 3887 pass, 81 skip, 0 fail; exit 0
bun run build
# pass, no dist/tests
npm pack --ignore-scripts --pack-destination /tmp/1199-package
# local tarball only; no publication hooks or README churn
```

Earlier full-check failures were inspected and corrected: nonexistent reranker
fixture files now exist under its sandbox; obsolete implicit-all expectations
in supersession/lifecycle tests request explicit all/historical instead, retaining
the original assertions. New test type-narrowing errors were fixed. No test was
skipped or failure allowlisted.

The tarball was installed with `bun add` in a disposable clean project. The
compiled package's `dist/commands/read/search{,-cli}.js` was inspected to confirm
actual current defaults. Same-version/fixed-filename cache reuse was rejected as
verification evidence; a unique tarball filename and fresh install directory
resolved it. Public `akm-cli/api` imports under both Bun and Node matched the
installed CLI byte for byte for current and historical tasks. Installed search
omitted/current/all/historical modes were separately asserted. The record includes
the final tarball hash; the installed-path JSON contains the representative outputs.

No Docker-gated or external semantic e2e suite was enabled; actual remote semantic
retrieval is covered by the separately recorded lab collections. Full repository
checks use deterministic/local isolation and their existing explicit skips.
