# Contract Tests

This directory holds **doc-pinning contract tests** for the v1 architecture
spec (`docs/technical/v1-architecture-spec.md`). Each test file pins a
specific locked section. Test names reference the spec section they
enforce, so a failure points to both the test and the doc.

## Why doc-pinning tests

Many v1 surfaces (proposal queue, agent CLI integration, `lesson`,
`llm.features.*`) are **declared** by the spec (§9.4, §11–§14) but not yet
implemented in code. The point of these tests is to catch silent
contract drift — if someone removes the locked declarations from the spec
or rewrites them in a way that contradicts the v1 freeze, these tests
fail.

When the corresponding feature ships, its implementer should keep this
file and add a sibling test that pins the runtime behaviour against the
same spec section.

## Sections pinned today

| File | Spec section | What it pins |
| --- | --- | --- |
| `v1-spec-section-4-1-asset-types.test.ts` | §4.1 | open asset-type set; renderer registry is the authority |
| `v1-spec-section-4-2-quality-rules.test.ts` | §4.2 | open `quality` set; `proposed` excluded by default; `--include-proposed` opt-in |
| `v1-spec-section-5-configuration.test.ts` | §5 | locked top-level config keys; literal-or-env value form; `writable` rejection |
| `v1-spec-section-6-orchestration.test.ts` | §6 | search/show via indexer; write-target resolution; ephemeral `index.db` |
| `v1-spec-section-7-module-layout.test.ts` | §7 | locked anchor modules + on-disk presence |
| `v1-spec-section-8-extension-points.test.ts` | §8 | six pluggable surfaces; four deliberately not extensible |
| `v1-spec-section-9-4-cli-surface.test.ts` | §9.4 | shipped + planned CLI command surface |
| `v1-spec-section-9-7-llm-agent-boundary.test.ts` | §9.7 | bounded stateless in-tree LLM; shell-out-only agents |
| `v1-spec-section-11-proposal-queue.test.ts` | §11 | proposal storage shape + commands + events; multi-proposal-per-ref; `accept` → `writeAssetToSource()` |
| `v1-spec-section-12-agent-config.test.ts` | §12 | `agent.*` config block + built-in profiles |
| `v1-spec-section-13-lesson-type.test.ts` | §13 | `lesson` frontmatter contract + runtime registration |
| `v1-spec-section-14-llm-features.test.ts` | §14 | seven locked `llm.features.*` keys + `tryLlmFeature` graceful-fallback seam |
