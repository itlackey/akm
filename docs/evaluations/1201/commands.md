# Reproduction commands

Run from akm-eval `33c8f78` with Bun 1.4.1. `BASE` is an archive/checkout of
AKM `d2369845a`; `CANDIDATE` is this PR. Both use locked AKM dependencies.
The private profile replaces only `semanticConfig()`/model identity with the
owner-approved remote Qwen settings recorded in provenance; no secret or endpoint
is published. Default collector semantics otherwise remain 0.3.

```sh
bun scripts/smoke/src/run.ts --contract --only retrieval --akm "bun $BASE/src/cli.ts"
bun evals/retrieval/src/run.ts --akm "bun $BASE/src/cli.ts" --limit 6 --label 1201-keyword-preflight
bun evals/retrieval/src/run.ts --akm "bun $BASE/src/cli.ts" --semantic --limit 6 --label 1201-hybrid-preflight
bun evals/retrieval/src/run.ts --akm "bun $BASE/src/cli.ts" --label 1201-baseline-keyword
bun evals/retrieval/src/run.ts --akm "bun $BASE/src/cli.ts" --semantic --label 1201-baseline-hybrid
bun evals/retrieval/src/run.ts --akm "bun $CANDIDATE/src/cli.ts" --label 1201-candidate-keyword
bun evals/retrieval/src/run.ts --akm "bun $CANDIDATE/src/cli.ts" --semantic --label 1201-candidate-hybrid
bun evals/retrieval/src/run.ts --akm "bun $BASE/src/cli.ts" --cases private/retrieval/1201-final --semantic --label 1201-final-baseline
bun evals/retrieval/src/run.ts --akm "bun $CANDIDATE/src/cli.ts" --cases private/retrieval/1201-final --semantic --label 1201-final-candidate
```

The archive's `final/cases/` is that final custom corpus. After pooling and
judging, append the collection-specific `judgment-additions.jsonl` rows to the
matching public qrels without the `collection` key. Rescore **both** builds with
`scripts/rescore/src/run.ts RESULTS_DIR...`; final saved rescored copies use
`-rescored-2` after correcting provenance digests. Compare with:

```sh
bun scripts/compare/src/run.ts BASELINE_RESULTS CANDIDATE_RESULTS --json comparison.json --md comparison.md
```

The archive's scripts use the existing evaluator sandbox/ask/load helpers for
defaults, same-index control, vector capture/replay, and installed verification.
Substitute checkout/temp paths before rerunning. Replay is offline and consumes
the four retained `q008-vector-*.json` responses. It does not request new vectors.

From the AKM candidate repository:

```sh
bunx biome check --write src/ tests/
bun test tests/curate-logic.test.ts tests/curate-rerank.test.ts tests/integration/curate-recall-controls.test.ts
bun run check
bun run build
bun pm pack --filename /tmp/akm-cli-1201-social-abstention.tgz --ignore-scripts --quiet
```

Install the tarball with `bun add /tmp/akm-cli-1201-social-abstention.tgz` in a
fresh temporary directory. The artifact's installed scripts compare both Bun
and Node public API output to the packaged CLI, then exercise its bin launcher.
No publish/merge/deployment command was run.
