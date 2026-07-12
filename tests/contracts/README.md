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

Contract filenames describe the current behavior they protect. Historical v1
section names are intentionally absent from this active suite.

## Sections pinned today

| File | Current contract |
| --- | --- |
| `asset-types.test.ts` | Runtime asset registry and current architecture docs |
| `quality-rules.test.ts` | Runtime quality normalization and proposed filtering |
| `configuration.test.ts` | Engine/strategy schema and source write constraints |
| `runtime-boundaries.test.ts` | Current search/show/write/storage architecture |
| `module-boundaries.test.ts` | Current module-boundary anchors |
| `extension-points.test.ts` | Supported source and registry provider boundaries |
| `improve-cli-surface.test.ts` | Current improvement CLI surface |
| `engine-boundary.test.ts` | Engine lowering and stateless LLM boundary |
| `lesson-type.test.ts` | Lesson registration and lint behavior |
