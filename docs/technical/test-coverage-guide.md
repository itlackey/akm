# Test Coverage Guide

This repo now has broad coverage across the major CLI, indexing, registry, and
semantic-search paths. Use this file as a current gap guide, not a greenfield
test plan.

## Areas With Strong Existing Coverage

- database and scoring (`tests/integration/db.test.ts`, `tests/integration/db-scoring.test.ts`, `tests/integration/fts-field-weighting.test.ts`)
- search/show CLI surfaces (`tests/integration/commands/search-cli-envelope.test.ts`, `tests/integration/commands/show.test.ts`, and the other `search-*`/`show-*` suites under `tests/integration/`)
- registry install/search/update/list flows
- workflow, vault, and wiki behavior
- semantic status, vector search, and embedding config behavior
- CLI error handling and output shaping
- Docker install validation

## Highest-Value Remaining Gaps

1. corrupt or version-mismatched DB fallback behavior during search
2. local model download and ONNX startup failures
3. partial embedding-generation failures during indexing
4. concurrent search/embedder behavior under load
5. semantic readiness reporting parity between `setup`, `search`, and `info`
6. broader platform CI for Alpine/musl, ARM, and Windows edge cases

## When Adding Tests

- prefer focused `bun:test` files under `tests/`
- use isolated temp config/cache/stash dirs
- cover the user-visible CLI behavior when the risk is output shaping or command routing
- cover internal units directly when the risk is scoring, metadata extraction, or persistence

## Useful Existing Suites To Extend

- `tests/integration/commands/search-cli-envelope.test.ts`
- `tests/integration/commands/show.test.ts`
- `tests/integration/vector-search.test.ts`
- `tests/integration/semantic-status.test.ts`
- `tests/setup-wizard.test.ts`, `tests/setup-scheduled-tasks.test.ts`
- `tests/integration/info-command.test.ts`
- `tests/integration/docker-install.test.ts`
