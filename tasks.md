# Output Redesign Tasks

Based on `.plans/output/akm-output-redesign.md` and `.plans/output/akm-implementation-guide.md`.

## Recommended Implementation Order

- [x] Stage 0 - Baseline: capture current behavior with focused CLI/search/show snapshots before changing output defaults
- [x] Stage 1 - Schema and CLI surface: implement `output` config, `--detail`, `--format`, `action`, `origin`, `size`, and `ref` as the only supported output interface
- [x] Stage 2 - Output routing: replace the current CLI formatting flow with `resolveOutputMode()` and detail-aware shaping using `--format` and config defaults
- [x] Stage 3 - Show formatting fixes: make plain-text `show` complete and safe for scripts, commands, agents, skills, and knowledge
- [x] Stage 4 - Cleanup: remove `usageGuide`, old output fields, and the agent prompt preamble once the replacement output shape is covered by tests
- [x] Stage 5 - Follow-up polish: command `parameters`, ref/origin doc cleanup, and optional ref simplification explicitly deferred

## Iterative Review Loop

- [x] After each stage, run `bun run check` before requesting review
- [x] After each stage, dispatch a review agent to inspect only the files changed in that stage for output-shape regressions, compatibility risks, and dead code
- [x] Apply review feedback immediately, then re-run `bun run check`
- [x] Dispatch a second review pass after fixes if the first review found substantive issues
- [x] Before starting the next stage, record any follow-up issues discovered during review as explicit checklist items here
- [x] Do a final cross-stage review-agent pass once all stages are complete, focused on consistency across `cli.ts`, `stash-search.ts`, `renderers.ts`, `stash-show.ts`, and `stash-types.ts`

### Resolved Review Follow-Ups

- [x] Preserve equals-form global flags in CLI normalization (`--format=...`, `--detail=...`)
- [x] Fix fallback local-hit sizing so unknown byte counts do not default to `small`
- [x] Expand command parameter extraction coverage for `$1...$9` and `{{named}}`
- [x] Add baseline output coverage for default and full-detail CLI shapes
- [x] Keep text output consistent for local assets by rendering `origin: null`
- [x] Add tests proving config-driven defaults and CLI override behavior
- [x] Align docs with implemented behavior for config, indexing, ranking, refs, and show behavior

## Phase 1 - Non-Breaking Additions

- [x] Add `output.format` and `output.detail` to `AgentikitConfig` and `DEFAULT_CONFIG` in `config.ts`
- [x] Add `output.format` and `output.detail` support to `config-cli.ts`, including validation
- [x] Add config round-trip tests for the new output settings
- [x] Add `--detail` to `search` and `show` in `cli.ts`
- [x] Add `--format json|text|yaml` to `search` and `show` in `cli.ts`
- [x] Implement `resolveOutputMode()` in `cli.ts` so CLI flags override config
- [x] Add `action?: string` to `LocalSearchHit`, `RegistrySearchResultHit`, and `ShowResponse` in `stash-types.ts`
- [x] Add per-type `action` strings to all renderer `buildShowResponse()` implementations in `renderers.ts`
- [x] Add per-hit `action` strings to local hits in `stash-search.ts`
- [x] Add install-first `action` strings to registry hits in `stash-search.ts`
- [x] Add tests that verify `action` is present on all search hit types and show responses
- [x] Add `origin?: string | null` to `LocalSearchHit` and `ShowResponse` in `stash-types.ts`
- [x] Replace `registryId` with `origin` in `stash-search.ts`
- [x] Replace `registryId` with `origin` in `stash-show.ts`
- [x] Add `fileSize?: number` to `StashEntry` in `metadata.ts`
- [x] Capture file size during indexing in `indexer.ts`
- [x] Add `size?: "small" | "medium" | "large"` to `LocalSearchHit` in `stash-types.ts`
- [x] Derive `size` from indexed file size in `stash-search.ts`
- [x] Replace `openRef` with `ref` for local hits in `stash-search.ts`
- [x] Replace `openRef` with `ref` in `stash-types.ts`
- [x] Replace `stripVerboseSearchFields()` with detail-aware search shaping in `cli.ts`

## Phase 2 - Default Output Changes

- [x] Rewrite `output()` in `cli.ts` to route through resolved `format` and `detail`
- [x] Change the default output format to JSON
- [x] Change the default output detail level to `brief`
- [x] Update plain-text `show` formatting in `cli.ts` so it includes all execution-relevant fields (`type`, `name`, `origin`, `action`, `run`, `setup`, `cwd`, `content`, `template`, `prompt`)
- [x] Ensure `schemaVersion` only appears in full-detail output where appropriate
- [x] Update output shaping so `brief`, `normal`, and `full` expose the intended field sets
- [x] Keep `yamlStringify` support only for explicit YAML output paths
- [x] Update or replace snapshot-style assertions for the new default JSON + brief output
- [x] Add tests for `--format json|text|yaml` and `--detail brief|normal|full`

## Phase 3 - Cleanup and Simplification

- [x] Remove `SearchUsageMode` from `stash-types.ts`
- [x] Remove `usageGuide` from `SearchResponse` in `stash-types.ts`
- [x] Remove `usageGuide` from the `AssetRenderer` interface in `file-context.ts`
- [x] Remove renderer-level `usageGuide` arrays from `renderers.ts`
- [x] Remove `--usage` from `search` in `cli.ts`
- [x] Remove `parseSearchUsageMode()` and all usage-mode plumbing from `stash-search.ts`
- [x] Remove `shouldIncludeUsageGuide()`, `shouldIncludeItemUsage()`, `buildUsageGuideFromEntries()`, `buildUsageGuide()`, `resolveGuideTypes()`, and `usageGuideByType()` from `stash-search.ts`
- [x] Remove usage-guide-specific tests and assertions across the test suite
- [x] Remove the hardcoded compliance preamble from the agent prompt in `renderers.ts`
- [x] Keep the compliance guidance in the new `action` field instead
- [x] Stop emitting old search/show fields: `hitSource`, `registryId`, `openRef`, `registrySource`, `installRef`, `installCmd`
- [x] Consolidate external output around `origin` and `ref`
- [x] Keep separate internal hit types and continue normalizing external output through the existing builders/CLI shapers

## Command Renderer Improvements

- [x] Add `parameters?: string[]` to `ShowResponse` in `stash-types.ts`
- [x] Implement command placeholder extraction in `renderers.ts` for `$ARGUMENTS`, `$1...$9`, and `{{named}}` placeholders
- [x] Emit extracted `parameters` from the command renderer show response
- [x] Add tests for command parameter extraction

## Ref and Origin Follow-Up

- [x] Update output consumers and tests to use `ref` instead of `openRef`
- [x] Update output consumers and tests to use `origin` instead of `registryId` / `hitSource`
- [x] Review docs that describe refs so they present `ref` as an opaque handle returned by search and consumed by show
- [x] Defer non-script ref simplification for a future follow-up and document that it is intentionally out of scope for this rollout

## Test Suite Updates

- [x] Update `tests/e2e.test.ts` for `ref`, `action`, `origin`, `--format`, and detail-level assertions
- [x] Update `tests/stash-search.test.ts` for new detail-level behavior and removal of usage-guide output
- [x] Update `tests/stash-show.test.ts` for `action` and `origin`
- [x] Update `tests/config.test.ts` for output config coverage
- [x] Grep for and replace assertions referencing `usageGuide`, `hitSource`, `openRef`, `registryId`, `installCmd`, `installRef`, `--json`, `--text`, and `--yaml`

## Validation

- [x] Run lint
- [x] Run type-check
- [x] Run full test suite
- [x] Manually verify `search` and `show` in JSON, YAML, and text modes at `brief`, `normal`, and `full` detail
- [x] Dispatch a final review agent on the completed branch and address any remaining issues before merge
