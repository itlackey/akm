# Test Coverage Guide

This repo now has broad coverage across the major CLI, indexing, registry, and
semantic-search paths. Use this file as a current gap guide, not a greenfield
test plan.

## Areas With Strong Existing Coverage

- database and scoring (`db.test.ts`, `db-scoring.test.ts`, `fts-field-weighting.test.ts`)
- stash search/show/resolve (`stash-search.test.ts`, `stash-show.test.ts`, `stash-resolve.test.ts`)
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

- `tests/stash-search.test.ts`
- `tests/stash-show.test.ts`
- `tests/vector-search.test.ts`
- `tests/semantic-status.test.ts`
- `tests/setup*.test.ts`
- `tests/info-command.test.ts`
- `tests/docker-install.test.ts`
