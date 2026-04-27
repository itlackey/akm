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
| `v1-spec-§4.1-asset-types.test.ts` | §4.1 | open asset-type set; renderer registry is the authority |
| `v1-spec-§4.2-quality-rules.test.ts` | §4.2 | open `quality` set; `proposed` excluded by default |
| `v1-spec-§9.4-cli-surface.test.ts` | §9.4 | shipped + planned CLI command surface |
| `v1-spec-§9.7-llm-agent-boundary.test.ts` | §9.7 | bounded stateless in-tree LLM; shell-out-only agents |
| `v1-spec-§11-proposal-queue.test.ts` | §11 | proposal storage shape + commands + events |
| `v1-spec-§12-agent-config.test.ts` | §12 | `agent.*` config block + built-in profiles |
| `v1-spec-§13-lesson-type.test.ts` | §13 | `lesson` frontmatter contract |
| `v1-spec-§14-llm-features.test.ts` | §14 | five locked `llm.features.*` keys |
