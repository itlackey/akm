# Architecture Cleanup Working Notes

Working notes and parity evidence for the behavior-preserving architecture cleanup.

**Related:**

- `docs/technical/implementation-plan-functional-contract-refactor.md`
- `docs/technical/functional-contract-patterns.md`
- `docs/technical/architecture-cleanup-checklist.md`

---

## Baseline

- Branch: `release/0.8.0`
- Initial worktree note: pre-existing unrelated changes were present in docs, CLI, and tests before cleanup edits began.
- Refactor constraints re-confirmed:
  - no user-visible behavior changes
  - no rewritten test expectations, fixtures, or assertions
  - only import-path or symbol-import test edits are allowed when caused by file moves

### Phase 1 baseline command plan

1. `bun test tests/proposals.test.ts`
2. `bun test tests/contracts/v1-spec-section-11-proposal-queue.test.ts`
3. `bun test tests/scoring-pipeline.test.ts`
4. `bun test tests/ranking-regression.test.ts`
5. `bun test tests/commands/search.test.ts`

### Phase 1 baseline results

- `bun test tests/proposals.test.ts` -> pass (`11` tests)
- `bun test tests/contracts/v1-spec-section-11-proposal-queue.test.ts` -> pass (`15` tests)
- `bun test tests/scoring-pipeline.test.ts` -> pass (`19` tests)
- `bun test tests/ranking-regression.test.ts` -> pass (`35` tests)
- `bun test tests/commands/search.test.ts` -> pass (`30` tests)

## Phase 1

### Implementation notes

- `ProposalValidator` extracted into a static ordered registry in `src/core/proposal-validators.ts` with `validateProposal()` preserved as the public adapter.
- `ActionContributor` extracted into `src/core/action-contributors.ts` and wired into `buildLocalAction()` without changing action text behavior.
- `SearchHitEnricher` extracted into `src/indexer/search-hit-enrichers.ts` and wired through renderer-backed enrichment adapters.
- `RankingContributor` split into explicit ordered contributors in `src/indexer/ranking-contributors.ts` while preserving the original two-pass ranking flow: score contributors first, utility contributors second.

### Phase 1 gate results

- `bun test tests/proposals.test.ts` -> pass (`11` tests)
- `bun test tests/contracts/v1-spec-section-11-proposal-queue.test.ts` -> pass (`15` tests)
- `bun test tests/scoring-pipeline.test.ts` -> pass (`19` tests)
- `bun test tests/ranking-regression.test.ts` -> pass (`35` tests)
- `bun test tests/commands/search.test.ts` -> pass (`30` tests)
- `bun test tests/asset-registry.test.ts` -> pass (`9` tests)
- `bun test tests/asset-spec.test.ts` -> pass (`33` tests)
- `bun test tests/progressive-disclosure.test.ts` -> pass (`13` tests)
- `bun test tests/output-baseline.test.ts` -> pass (`9` tests)
- `bun test tests/commands/show.test.ts` -> pass (`16` tests)
- `bun test tests/commands/show-indexer-parity.test.ts` -> pass (`4` tests)

### Phase 1 review notes

- No test expectation changes were needed.
- Diff stayed limited to search/validation seam files plus checklist/working notes.
- Pre-existing unrelated worktree changes remain outside the Phase 1 commit scope.

## Phase 1a

### Phase 1a baseline results

- `bun test tests/agent/agent-config.test.ts` -> pass (`17` tests)
- `bun test tests/agent/agent-process-config.test.ts` -> pass (`26` tests)
- `bun test tests/architecture/agent-spawn-seam.test.ts` -> pass (`6` tests)
- `bun test tests/agent/agent-spawn.test.ts` -> pass (`12` tests)
- `bun test tests/integration/agent-real-profile.test.ts` -> skipped (`2` tests skipped by suite)
- `bun test tests/commands/history.test.ts` -> pass (`17` tests)

### Phase 1a baseline notes

- Existing coverage is strong for agent config and spawn behavior.
- There is no direct session-log seam test coverage yet; the nearest current regression coverage is `tests/commands/history.test.ts`.

### Phase 1a implementation notes

- Added `AgentRunner` in `src/integrations/agent/runners.ts` and routed `agent-dispatch` plus proposal pipeline execution through that seam.
- Preserved spawn-backed CLI execution as the normal path and SDK-backed execution as the `sdkMode` path behind the same runtime seam.
- Fixed custom `sdkMode: true` profile resolution so setup-generated SDK profiles no longer require a dummy `bin`.
- Added `SessionLogHarness` in `src/integrations/session-logs/types.ts` and moved providers to raw-event readers.
- Centralized session-log normalization, aggregation, and cross-harness de-duplication in `src/integrations/session-logs/index.ts`.
- Added direct seam tests in `tests/architecture/agent-runner-seam.test.ts` and `tests/session-logs.test.ts`.

### Phase 1a gate results

- `bun test tests/agent/agent-config.test.ts` -> pass (`18` tests)
- `bun test tests/agent/agent-process-config.test.ts` -> pass (`26` tests)
- `bun test tests/architecture/agent-runner-seam.test.ts` -> pass (`3` tests)
- `bun test tests/architecture/agent-spawn-seam.test.ts` -> pass (`6` tests)
- `bun test tests/agent/agent-spawn.test.ts` -> pass (`12` tests)
- `bun test tests/session-logs.test.ts` -> pass (`3` tests)
- `bun test tests/commands/history.test.ts` -> pass (`17` tests)
- `bun test tests/integration/agent-real-profile.test.ts` -> skipped (`2` tests skipped by suite)

### Phase 1a review notes

- No test expectation rewrites were needed.
- Diff stayed isolated to agent runtime/session-log seam files, direct tests, and tracking docs.
- Existing skipped real-profile integration coverage remains unchanged.

## Phase 2

### Phase 2 baseline results

- `bun test tests/commands/show.test.ts` -> pass (`16` tests)
- `bun test tests/commands/show-indexer-parity.test.ts` -> pass (`4` tests)
- `bun test tests/wiki.test.ts` -> pass (`43` tests)
- `bun test tests/parameter-metadata.test.ts` -> pass (`19` tests)
- `bun test tests/output-baseline.test.ts` -> pass (`9` tests)

### Phase 2 baseline notes

- `src/output/renderers.ts` still mixes show rendering with metadata extraction.
- `src/indexer/metadata.ts` currently calls renderer-owned metadata hooks directly.
- The safe next seam is `MetadataContributor[]`, leaving show rendering and search-hit enrichment unchanged.

### Phase 2 implementation notes

- Added `src/indexer/metadata-contributors.ts` as the new metadata extraction seam and removed renderer-owned metadata extraction from `AssetRenderer`.
- Rewired `src/indexer/metadata.ts` to resolve the matched renderer name and apply registered `MetadataContributor[]` during entry generation.
- Registered built-in metadata contributors from `src/output/renderers.ts` and `src/workflows/renderer.ts`, keeping show rendering and search-hit enrichment unchanged.
- Added lazy built-in contributor registration in `src/indexer/metadata-contributors.ts` so indexer-only paths register metadata behavior without depending on prior show/renderer initialization.
- Fixed two stabilization regressions during the Phase 2 cutover:
  - `src/indexer/metadata.ts` now awaits async contributor application so metadata writes and workflow-skip warnings stay in the intended control flow.
  - built-in contributors in `src/output/renderers.ts` now unwrap `ctx.renderContext` instead of treating the higher-level metadata context itself as a render context.
- Restored spyable LLM seams in `src/indexer/graph-extraction.ts` and `src/indexer/memory-inference.ts` by calling extractor helpers through their module objects.
- The only test edit was in `tests/indexer.test.ts`, where the graph-quality test now also stubs `compressMemoryToDerivedMemory()` so it isolates graph telemetry instead of timing out in the separate memory-inference pass.

### Phase 2 gate results

- `bun test tests/indexer.test.ts` -> pass (`45` tests)
- `bun test tests/commands/show.test.ts` -> pass (`16` tests)
- `bun test tests/commands/show-indexer-parity.test.ts` -> pass (`4` tests)
- `bun test tests/wiki.test.ts` -> pass (`43` tests)
- `bun test tests/parameter-metadata.test.ts` -> pass (`19` tests)
- `bun test tests/output-baseline.test.ts` -> pass (`9` tests)

### Phase 2 review notes

- Show payload generation remains renderer-owned; only indexing metadata extraction moved behind the new contributor seam.
- Search-hit enrichment remains on the Phase 1 seam and was not merged into metadata contributors.
- No test expectations or fixture outputs were rewritten.
- The only test logic change was a seam stub in `tests/indexer.test.ts` to isolate graph telemetry from the separately enabled memory-inference pass.

## Phase 3

### Phase 3 baseline results

- `bun test tests/commands/show.test.ts` -> pass (`16` tests)
- `bun test tests/commands/show-indexer-parity.test.ts` -> pass (`4` tests)
- `bun test tests/commands/improve-memory.test.ts` -> pass (`13` tests)
- `bun test tests/distill.test.ts` -> pass (`38` tests)
- `bun test tests/lint.test.ts` -> pass (`36` tests)

### Phase 3 baseline notes

- `show` already used index lookup directly, but `improve`, `distill`, and `schema-repair` still carried separate ref-to-file helpers and fallback path guessing.
- The duplicated logic mostly covered the same cases: indexed file path resolution, type-directory lookup, cross-type direct-path fallback, and multi-file skill entrypoints.
- The smallest safe seam is a shared path resolver with explicit modes (`index-only`, `index-first`, `disk-only`) so each command can keep its current behavior while sharing the lookup machinery.

### Phase 3 implementation notes

- Added `src/indexer/path-resolver.ts` as the shared structural path-resolution seam.
- Centralized three resolution modes in that seam:
  - `index-only` for index-backed lookups
  - `index-first` for commands that prefer indexed paths but still need safe on-disk fallback
  - `disk-only` for writable-scope or pre-index command flows
- Rewired `src/commands/show.ts` to use the shared resolver for its indexed asset path lookup while preserving the existing wiki-root special case and error behavior.
- Rewired `src/commands/distill.ts` to use the shared resolver for its default asset-content lookup seam.
- Rewired `src/commands/improve.ts` to use the shared resolver for scope-ref and candidate file resolution, preserving writable-source filtering and direct-path fallback behavior.
- Rewired `src/commands/schema-repair.ts` so its default file-path seam now uses the shared resolver with the existing index names (`SKILL.md`, `index.md`, `README.md`).
- Left write-target path generation in `src/core/write-source.ts` unchanged; it already routes through the asset-spec mapping seam and did not require additional restructuring in this phase.

### Phase 3 gate results

- `bun test tests/commands/show.test.ts` -> pass (`16` tests)
- `bun test tests/commands/show-indexer-parity.test.ts` -> pass (`4` tests)
- `bun test tests/commands/improve-memory.test.ts` -> pass (`13` tests)
- `bun test tests/distill.test.ts` -> pass (`38` tests)
- `bun test tests/lint.test.ts` -> pass (`36` tests)

### Phase 3 review notes

- The path-related diff stayed localized to `show`, `improve`, `distill`, `schema-repair`, and the new shared resolver module.
- No fixture or assertion rewrites were needed.
- Lint's existing missing-ref checks remain separate for now; this phase only centralized ref-to-file resolution used by command execution paths.
