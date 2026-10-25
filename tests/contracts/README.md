# Contract Tests

This directory holds active architecture, runtime, schema, and documentation
contracts. `docs/architecture/architecture.md` and the production modules named by
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
| `quality-rules.test.ts` | Runtime quality normalization and proposed filtering |
| `configuration.test.ts` | Connection, harness and strategy schema, source write constraints, and the retired-selector scan over the active docs |
| `runtime-boundaries.test.ts` | Current search/show/write/storage architecture |
| `module-boundaries.test.ts` | Current module-boundary anchors |
| `extension-points.test.ts` | Supported source and registry provider boundaries |
| `improve-cli-surface.test.ts` | Current improvement CLI surface |
| `response-schemas-strict.test.ts` | Every response schema akm sends is valid for a strict structured-output provider |
| `runtime-port-boundary.test.ts` | Only `integrations/agent/runtime.ts` names the agent runtime's implementation, and the implementation reads no config |
