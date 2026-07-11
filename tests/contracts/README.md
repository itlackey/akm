# Contract Tests

This directory holds active architecture, runtime, schema, and documentation
contracts. `docs/technical/architecture.md` and the production modules named by
each test are current truth. The archived v1 planning spec is historical context,
not a test input or live contract.

## Contract policy

Contracts should prefer observable runtime behavior and generated schemas.
Current documentation is pinned where it communicates an operator-facing
requirement. Tests must not inspect archived specifications or depend on their
line structure.

Several filenames retain their original `v1-spec-section-*` names to preserve
test history. Their contents now enforce current contracts only.

## Sections pinned today

| File | Current contract |
| --- | --- |
| `v1-spec-section-4-1-asset-types.test.ts` | Runtime asset registry and current architecture docs |
| `v1-spec-section-4-2-quality-rules.test.ts` | Runtime quality normalization and proposed filtering |
| `v1-spec-section-5-configuration.test.ts` | Engine/strategy schema and source write constraints |
| `v1-spec-section-6-orchestration.test.ts` | Current search/show/write/storage architecture |
| `v1-spec-section-7-module-layout.test.ts` | Current module-boundary anchors |
| `v1-spec-section-8-extension-points.test.ts` | Supported source and registry provider boundaries |
| `v1-spec-section-9-4-cli-surface.test.ts` | Current improvement CLI surface |
| `v1-spec-section-9-7-llm-agent-boundary.test.ts` | Engine lowering and stateless LLM boundary |
| `v1-spec-section-11-proposal-queue.test.ts` | Proposal runtime storage, lifecycle, commands, and events |
| `v1-spec-section-12-agent-config.test.ts` | Engine schema, harness platforms, and dispatch failures |
| `v1-spec-section-13-lesson-type.test.ts` | Lesson registration and lint behavior |
