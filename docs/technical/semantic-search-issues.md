# Semantic Search Issues Checklist

Current state snapshot after the recent semantic-search fixes.

## Fixed

- [x] Vector search path has dedicated tests (`tests/vector-search.test.ts`)
- [x] `semantic-status.ts` has dedicated tests (`tests/semantic-status.test.ts`)
- [x] `semanticSearchMode` schema/config mismatch was fixed
- [x] `@huggingface/transformers` moved to optional dependency
- [x] usage events survive index rebuilds/schema resets
- [x] semantic failure reasons now distinguish native-lib/onnx/auth/network cases
- [x] fingerprint mismatch warns and resets readiness
- [x] index trust checks stored `stashDirs`, not only the primary stash
- [x] blocked semantic status auto-recovers after TTL
- [x] `writeSemanticStatus()` cleans up temp files on rename failure
- [x] embedding cache keys now include endpoint/model context

## Still Open

- [ ] JS fallback still scans all embeddings into memory for large indexes
- [ ] Concurrent local embedder access can still race across model switches
- [ ] Incremental indexing does not fully regenerate embeddings after model changes without `--full`
- [ ] There is still no platform-specific CI coverage for Alpine/ARM/Windows semantic behavior
- [ ] Large-index warning behavior remains coarse compared with actual runtime memory pressure

## Remaining Test Gaps

- [ ] corrupt or version-mismatched DB behavior during search
- [ ] local model download failure paths
- [ ] ONNX runtime initialization failure paths
- [ ] partial embedding-generation failures during indexing
- [ ] concurrent search access against the same DB
- [ ] CLI-level `akm setup` semantic readiness subprocess coverage
- [ ] `akm info` semantic reporting across ready/blocked transitions
