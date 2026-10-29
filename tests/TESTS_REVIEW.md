# Tests Directory Review — retired

**Original review date:** 2026-07-26 (commit `821c8f47`)
**Triaged item-by-item:** 2026-08-12, against the tree at commit `c0994ae`
**Status:** closed as a document. This is a disposition record, not a problem list.

The original 672-line review is preserved verbatim in git history:

```sh
git show 821c8f47:tests/TESTS_REVIEW.md
```

It is not reproduced here because it read as a live list of unresolved
problems long after most of its findings had been fixed — the staleness that
issue #773 was opened to correct. Every one of its 67 numbered findings now
carries a disposition below.

## Why the document went stale

The review landed on 2026-07-26. A remediation program ("Phase 2") worked
through most of it on **2026-07-27** across eleven commits — `3408159a`,
`6c92d96a`, `a1262a68`, `e511ff6d`, `8cf96889`, `0f7790e8`, `7af9e8e3`,
`d7594c6c`, `026cfb91`, `d37f6b5c`, `63aa59f5` — but never updated the review
itself. Its only subsequent edit was one mechanical `AKM_STASH_DIR` →
`AKM_BUNDLE_DIR` rename (`363dbe26`).

## Disposition summary

| | Count |
| --- | --- |
| Findings total | **67** |
| Fixed | **51** |
| Still open | **12** |
| Superseded by decision | **4** |

Disposition rules used:

- **fixed** — every location the finding cites has been addressed at HEAD.
- **still-open** — at least one cited location is unchanged and the defect
  still holds. Several are *reduced*: part of the finding was fixed and the
  remainder is named in the evidence column.
- **superseded-by-decision** — the behavior is unchanged on purpose and the
  decision is recorded in the tree.

## Where the live items now live

The still-open findings are grouped into five themed clusters — one per theme,
not one per finding — so live work is visible in the tracker rather than
buried here. Nothing below should be worked from this file.

| Cluster | Findings | Theme |
| --- | --- | --- |
| ORG | ORG-03, ORG-04, ORG-05, ORG-06 | the test tree has no unit/integration classification rule |
| DUP | DUP-03, DUP-07, DUP-10, DUP-12 | remaining near-duplicate coverage and copy-pasted CLI-envelope harnesses |
| VALUE | VALUE-16, plus the VALUE-02 and VALUE-17 residuals below | assertions weaker than the test names promise |
| RUNTIME | RUNTIME-07 (residual) | one remaining scheduler-sensitive suite |
| ISOLATION | ISOLATION-04, ISOLATION-05 | process-global state with no reset seam |

Two derived items came out of the fixes themselves rather than the original
findings, and belong with the clusters above:

- The `ISOLATION-08` widening of `AKM_ENV_VARS` grandfathered **22**
  pre-existing files into the isolation allowlist; the linter and its
  allowlist have since been deleted.
- Deleting the false vector-only test (`VALUE-02`) left **no ungated test
  driving `akmSearch` on a vector-only match path** — recorded in `8cf96889`'s
  own commit body as "NOT closed by this work".

## Full disposition table

### Organization and discovery

| Finding | Disposition | Evidence at HEAD |
| --- | --- | --- |
| ORG-01 | fixed | The testing workflow's "Test Targets" section states that `tests/commands/` and `tests/workflows/` run under the unit target, matching `scripts/test-unit.sh`; `026cfb91` |
| ORG-02 | fixed | `tests/integrations/` (plural) no longer exists; the three files moved to `tests/agent/`; `e511ff6d` |
| ORG-03 | **still open** (reduced) | The cited mismatch is gone — the real `npm pack`/`install --global` test moved to `tests/integration/package-install.test.ts:5-17` (`6c92d96a`) — but the root bucket itself grew from 78 to **94** unclassified `tests/*.test.ts` files |
| ORG-04 | **still open** (reduced) | Four migration tests moved out of `tests/_fixtures/` to `tests/migrate/legacy/` (`6c92d96a`); `tests/fixtures/stashes/load.test.ts` is still an executable test inside a fixture namespace |
| ORG-05 | **still open** (reduced) | Three of nine addressed (`project-context.test.ts` moved to `tests/`; the two `graph-extraction-*` headers now justify their placement, `63aa59f5`). Still self-describing as unit tests: `tests/integration/graph-boost-cache-reset.test.ts:2`, `standards-prompt-injection.test.ts:6`, `commands/consolidate/consolidate-chunks.test.ts:11`, `commands/improve/salience.test.ts:6`, `commands/improve/outcome-loop.test.ts:6` |
| ORG-06 | **still open** | Layout still mixes flat and per-command nesting; the root/nested split under `tests/integration/` widened from 237/134 to **256/131** |
| ORG-07 | superseded | Naming unified on `.characterization.test.ts` (`63aa59f5`); the single `.bench.` file stays in the unit target by explicit decision recorded at `tests/commands/distill/distill-promotion-policy.bench.test.ts:2` |
| ORG-08 | fixed | `tests/fixtures/stashes/curate-golden/MANIFEST.json` added, so `listFixtures()` reports all five; `tests/fixtures/stashes/load.test.ts:72` now pins the five-item list; `d37f6b5c` |
| ORG-09 | fixed | The testing workflow ("Test Layers", "1. Fast local correctness") and `tests/integration/semantic-search-e2e.test.ts` name the real path, and the workflow presents `bun run check`, not bare `bun test`; `026cfb91` |
| ORG-10 | fixed | Titles disambiguated at `tests/config-cli.test.ts:253,258` (`… value 'true'` / `… value 'false'`); `a1262a68` |

### Duplicate and redundant coverage

| Finding | Disposition | Evidence at HEAD |
| --- | --- | --- |
| DUP-01 | fixed | `tests/integration/commands/import.test.ts:93-171` is one `--target` block of five distinct scenarios; the duplicate block is gone; `a1262a68` |
| DUP-02 | fixed | `tests/commands/remember.test.ts:77-163` keeps three target cases plus the distinct default-bundle case; the renamed-fixture copies are gone; `a1262a68` |
| DUP-03 | **still open** | `tests/agent/agent-spawn.test.ts:103-132,166,220` and `tests/architecture/agent-spawn-seam.test.ts:113,155,179` still both cover captured success, non-zero exit, spawn failure, parse failure, and timeout |
| DUP-04 | fixed | Two of four copies deleted with in-place markers at `tests/agent/agent-builders.test.ts:412-414,450-451`; three distinct surviving variants kept deliberately (`:316`, `:334`, `:609`); `e511ff6d` |
| DUP-05 | fixed | The WS2 block is deleted, with the reason recorded at `tests/integration/agent-output.test.ts:233-237`; `e511ff6d` |
| DUP-06 | fixed | No `detectTruncatedDescription` reference remains in `tests/integration/commands/consolidate/consolidate-pipeline-fixes.test.ts`; the 12 helper cases live only in `tests/core/text-truncation.test.ts`; `8cf96889` |
| DUP-07 | **still open** | `tests/cooldown-select-fix.test.ts:175-200` still repeats the selector cases from `tests/commands/improve/proactive-maintenance.test.ts:33,47`; the file is untouched since `76dcfffc` (2026-07-19), before the review |
| DUP-08 | fixed | `tests/agent/agent-process-config.test.ts:19-40` retains only three tests (incl. the uniquely-covered `timeoutMs: null`); the runner file moved to `tests/agent/runner.test.ts`; `e511ff6d` |
| DUP-09 | fixed | `tests/integration/env-path-run.test.ts` no longer mentions `vault`; the check lives only in `tests/integration/env.test.ts:543` |
| DUP-10 | **still open** | `tests/integration/registry-search.test.ts:565-571` and `:770-777` still assert the same three things through two paths |
| DUP-11 | fixed | Three of four overlaps deleted (`0f7790e8`): the wave2-d exit-code block, the frontmatter block, and the `assembleInfo` existence check. The fourth (`shapeSearchHit` registry brief, now `tests/commands/consolidate/consolidate-wave2-e.test.ts:62-98`) was kept deliberately as the only `installRef`/`title→name` coverage |
| DUP-12 | **still open** (grown) | The identical `runCli` wrapper + `beforeEach`/`afterEach` block now appears in **11** `*-cli-envelope.test.ts` files (e.g. `tests/commands/config-cli-envelope.test.ts:29-42` and `tests/integration/commands/env-cli-envelope.test.ts:25-41`), up from the five cited |

### Tests with little or misleading value

| Finding | Disposition | Evidence at HEAD |
| --- | --- | --- |
| VALUE-01 | fixed | `tests/commands/consolidate/consolidate-wave2-bc.test.ts:296-312` replaces the config-shape check with a test that drives `searchLocal` at engineered scores 0.18/0.27 against the real 0.2 floor; `0f7790e8` |
| VALUE-02 | fixed (residual) | The false test is deleted; `tests/integration/parallel-search.test.ts` no longer claims vector-only coverage. Residual: no ungated test drives `akmSearch` on a vector-only path — recorded in `8cf96889` |
| VALUE-03 | fixed | The signature-only test is deleted; `tests/integration/info-command.test.ts:289-299` asserts `sourceProviders` empty with no bundle and exact contents with one; `0f7790e8` |
| VALUE-04 | fixed | The `Object.keys(out).length > 0` tautology is deleted with a marker at `tests/commands/consolidate/consolidate-wave2-e.test.ts:93-96`; a missing-field input was added at `:82-90`; `0f7790e8` |
| VALUE-05 | fixed | `tests/integration/setup.test.ts:205-211` now injects through `_setDetectForTests` and asserts the concrete result; `d7594c6c` |
| VALUE-06 | fixed | The data dir is isolated at `tests/commands/observability-cli-envelope.test.ts:40-46` (`d7594c6c`); the conditional `lessons` test went away with the command family in the 0.9.0 CLI overhaul |
| VALUE-07 | fixed | `tests/integration/migration-help.test.ts:92-131` extracts the traversal literal from production source and applies it at the real `dist/` depth; `8cf96889` |
| VALUE-08 | fixed | The four class-identity tests are deleted; `tests/commands/consolidate/consolidate-wave2-d.test.ts` no longer has an exit-code block; mapping stays in `tests/cli/exit-code-classification.test.ts`; `0f7790e8` |
| VALUE-09 | fixed | `tests/integration/commands/ref-input-boundary.test.ts:47` has two distinct spellings and the docstring at `:5-22` names `tests/resolve-ref.test.ts:271-274` as the colon-grammar rejection site; `8cf96889` |
| VALUE-10 | superseded | Key-set goldens are the documented convention, not an oversight: `tests/commands/goldens-cli-output.test.ts:10-20` designates them `frozen-migration-input` capture-only oracles, policed by `tests/fixtures/goldens/DESIGNATIONS.json` |
| VALUE-11 | fixed | `tests/integration/cli-global-error-handlers.test.ts` adds five spawn-based tests over both handlers, drilled by deleting the registrations; `63aa59f5` |
| VALUE-12 | fixed | `tests/architecture/llm-stateless-seam.test.ts:29-36` now states what the suite cannot catch and names `chatCompletionOverride` as the counterexample; `63aa59f5` |
| VALUE-13 | fixed | No `resolves.toBeDefined()` probe remains in `tests/integration/registry-build-index.test.ts`; each `buildRegistryIndex` call is asserted once; `8cf96889` |
| VALUE-14 | fixed | `tests/integration/workflows/params-validation.test.ts:178-185` asserts the run id and the tampered params verbatim; `8cf96889` |
| VALUE-15 | fixed | The weak block is deleted (marker at `tests/commands/consolidate/consolidate-wave2-e.test.ts:107-115`); `tests/remember-unit.test.ts:65,79,101` cover newline injection, metacharacters, and the empty description; `0f7790e8` |
| VALUE-16 | **still open** (reduced) | The redundant single-call smoke test is gone, but the survivor at `tests/integration/parallel-search.test.ts:140-145` still only asserts `not.toThrow()` — it does not prove cached values were discarded or recomputed |
| VALUE-17 | fixed (residual) | All three cited sites pinned: `tests/config-cli-silent-layer.test.ts:131-139` (exit 2 / `INVALID_FLAG_VALUE`), `tests/commands/remember.test.ts:127` (exit 78 / `INVALID_CONFIG_FILE`), and the weaker `completions.test.ts` unsupported-shell test deleted (`a1262a68`). Residual: ~48 `not.toBe(0)` status-only assertions remain tree-wide |

### Runtime, flakiness, and test design

| Finding | Disposition | Evidence at HEAD |
| --- | --- | --- |
| RUNTIME-01 | retired | The three-database cutover architecture and its 1000-seed property suite were deleted in the 0.9.2 convergence. The dedicated CI job was removed with it; `tests/contracts/ci-test-paths.test.ts` rejects future workflow references to missing test files. |
| RUNTIME-02 | retired | Workflow plan v3 execution and its map-expansion suite were deleted in favor of the one durable-v4 engine. Current v4 source, freeze, scheduler, and durability suites run in the normal unit/integration targets. |
| RUNTIME-03 | fixed | The real `npm pack`/`install --global` test moved to `tests/integration/package-install.test.ts`; `tests/package-install.test.ts:5-12` records that everything remaining is injected-fake logic; `6c92d96a` |
| RUNTIME-04 | fixed | The one call site of the spawning default path moved to `tests/integration/fixtures/stashes/load.test.ts`; the unit file at `tests/fixtures/stashes/load.test.ts:7-16` documents that it never spawns; `d37f6b5c` |
| RUNTIME-05 | fixed | `tests/integration/source-source.test.ts:607-635` uses a mocked `ensureWebsiteMirror` and a `.test` host; the note at `:612-622` explains why `.invalid` never reached the path at all; `d7594c6c` |
| RUNTIME-06 | fixed | Same change as VALUE-05 — no `ollama list` subprocess, no 10s fallback |
| RUNTIME-07 | **still open** (reduced) | Four of five sites fixed: `llm-client.test.ts:864` uses `setSystemTime`; `opencode-sdk-managed-server.test.ts:113,143` asserts liveness via `pollUntil`; `proposals.test.ts:1028` records the removed sleeps; `commands/events.test.ts` was examined and the finding rejected as mis-described (`3408159a`). Still open: `tests/integration/reflect-propose-http-timeout.test.ts:19-56` still runs real localhost servers against 1ms timeouts, untouched since before the review |
| RUNTIME-08 | fixed | `tests/llm-feature-gate.test.ts:182,226` clear the test-owned handle rather than leaving delayed work live; `3408159a` |
| RUNTIME-09 | fixed | `tests/integration/config.test.ts:396-409` removes the busy-spin, with proof that `pruneOldBackups` is count-based; `6c92d96a` |
| RUNTIME-10 | superseded | The review itself called this defensible. Two of three cited suites no longer exist (`goldens-consolidate-ops.test.ts` removed in `e82eec81`; `goldens-mv-txn.test.ts` with `akm mv` in `95a6c0a6`); `tests/commands/proposal/goldens-proposal-txn.test.ts` re-executes by design for fixture isolation |
| RUNTIME-11 | fixed | Every `bun test` in `tests/release-check.sh` passes `--timeout=120000`; the unified policy is stated at `:95-102`; `026cfb91` |
| RUNTIME-12 | fixed | Strict gates at `tests/integration/semantic-search-e2e.test.ts:30` and `tests/integration/docker-install.test.ts:113` (`=== "1"`); `026cfb91`, `7af9e8e3` |

### Isolation and shared state

| Finding | Disposition | Evidence at HEAD |
| --- | --- | --- |
| ISOLATION-01 | fixed | `tests/engine-resolution.test.ts:105-119` snapshots and restores `FAST_API_KEY` in `finally`; `d7594c6c` |
| ISOLATION-02 | fixed | `tests/integration/setup.test.ts:100-118` restores `USERPROFILE` in `finally`; `d7594c6c` |
| ISOLATION-03 | fixed | `tests/integration/semantic-search-e2e.test.ts:249-269` tracks `hfHomeMutated`/`savedHfHome` and `restoreEnv()` at `:257` restores exactly; `026cfb91` |
| ISOLATION-04 | **still open** | `src/registry/create-provider-registry.ts:13-26` still exposes only `register`/`resolve`/`list`. Call sites now save-and-restore in `finally` (`tests/provider-registry.test.ts:15-29`, `tests/integration/registry-search.test.ts:881-891`), but they do so by re-registering `undefined` — a workaround for the missing seam, not the seam |
| ISOLATION-05 | **still open** | `tests/integration/graph-boost-ranking.test.ts:86` still builds the database once in `beforeAll`; `beforeEach` at `:105-119` clears only the graph cache; `:304` and `:738` still mutate the stored graph |
| ISOLATION-06 | fixed | The single helper-side spawn moved to integration scope and its allowlist entry in the isolation linter (since deleted) retired with no replacement; `d37f6b5c` |
| ISOLATION-07 | fixed | `tests/lint-isolation-ratchet.test.ts:52` asserts every allowlisted path resolves to a real file; the two dead entries were removed; `d37f6b5c` |
| ISOLATION-08 | fixed (residual) | The isolation linter (since deleted) widened `AKM_ENV_VARS` from 5 names to the full 15-name `HARNESSED` contract. Residual: 22 pre-existing files grandfathered in |

### Test harness, release, and CI

| Finding | Disposition | Evidence at HEAD |
| --- | --- | --- |
| INFRA-01 | fixed | `tests/docker/smoke-test.sh:222-223` uses `akm show scripts/deploy/deploy-app.sh`; no `script:` grammar remains in the file; `7af9e8e3` |
| INFRA-02 | fixed | `tests/docker/run-docker-tests.sh:134-147` exits 1 when zero variants ran; no `|| true` remains in `tests/docker/smoke-test.sh`; `7af9e8e3` |
| INFRA-03 | superseded | `Dockerfile.alpine-binary` was deleted rather than wired in — the binary targets glibc and Alpine is musl. Recorded at `docs/architecture/testing/testing-workflow.md:179-183,283-285`; `7af9e8e3` |
| INFRA-04 | fixed | `.github/workflows/gated-ci.yml` supplies stable semantic, Docker, and native-scheduler jobs. They run weekly for drift detection, by exact-SHA manual dispatch, or from the exact commit targeted by a narrow release-candidate tag; the scheduler matrix covers Linux cron, macOS launchd, and Windows Task Scheduler. Contract: `tests/integration/workflow-gated-ci.test.ts`; #784 |
| INFRA-05 | fixed | `tests/release-check.sh:105-114` runs verify-only `bun run lint` (the same command CI gates on) instead of a mutating `biome check --write`; `026cfb91` |
| INFRA-06 | fixed | `scripts/test-integration.sh:43-45` promises logs are kept on failure and `:90-92` now delivers — the unconditional in-loop delete is gone, matching the unit runner; `026cfb91` |
| INFRA-07 | fixed | `tests/integration/semantic-search-e2e.test.ts` defaults `HF_HOME` to ignored, repo-local `.ci-cache/huggingface`, outside the preload's disposable `HOME`; CI restores a model/source-identified cache for every gated run, but saves it only from a trusted scheduled default-branch run. The test still restores `HF_HOME` exactly; #784 |
| INFRA-08 | fixed | Same change as RUNTIME-11 — one 120s policy across `scripts/test-unit.sh:68`, `scripts/test-integration.sh:57`, and every `tests/release-check.sh` step |

## Confidence

Every row above was checked by reading the cited file at HEAD. Fixing commits
are named where `git log -S` / `git log -- <path>` identified them; the full
history is required to resolve them (a shallow clone will not).

No finding was left undispositioned, and none was marked fixed on the strength
of a commit message alone.
