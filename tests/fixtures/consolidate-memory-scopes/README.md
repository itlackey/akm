# Memory scope consolidation (#1197)

`cases.jsonl` uses the existing akm-eval consolidation format and scorer. The
notes have identical fictional recovery claims. Three controls share a full,
partial, or absent tuple; six negative cases differ in one of the four scope
keys, scoped/unscoped status, or partial-tuple membership. `safe: []` labels a
cross-scope pair as unsafe to retire even though its textual relation is
`duplicate`. No scorer change is needed. These are development regression
fixtures, not a held-out corpus.

From the selected akm-eval checkout, verify `evals/consolidate/run --help` first:

```sh
evals/consolidate/run --akm "bun /path/to/akm/src/cli.ts" \
  --cases /path/to/akm/tests/fixtures/consolidate-memory-scopes \
  --embedder real --config-patch /path/to/private/embedding-config.json \
  --model configured-model --label scopes
```

The private patch selects the intended embedding endpoint/model; `--embedder
real` removes the deterministic environment override. A patch alone does not.
The checked pool runner accepts neither `--cases` nor `--limit`; its public
pool is a separate regression collection. Deterministic and real embedding
results are separate treatments. The model and all shipped prompts/defaults
remain unchanged for this code-only fix.

See the saved results in the akm-eval repository, the existing
complete-evidence fixtures, and the PR linked to #1197 for the single change
record, acceptance decision, budget, and rollout status. Tests in AKM pin exact
live scopes, eligible neighbor slots, promotion output, manual/staged/resumed
acceptance, legacy records, differently scoped twins, and archive/revert. The
pair scorer measures proposals and stages; the isolated installed-path receipt
and integration tests measure actual acceptance and recovery.
