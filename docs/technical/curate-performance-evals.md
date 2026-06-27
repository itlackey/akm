# Curate Performance Evals

Use this when tuning `akm curate` ranking, fallback, or family-collapsing behavior.

Related context:

- Implementation plan: `docs/0.9.0-curate-quality-implementation-plan.md`
- Workmap: `docs/agents/curate-workmap.md`
- Primary eval test: `tests/curate-relevance-eval.test.ts`
- Logic tests: `tests/curate-logic.test.ts`
- Fallback tests: `tests/curate-search-for-curation.test.ts`
- CLI behavior tests: `tests/curate-command.test.ts`
- Cross-version benchmark (deterministic, rank-aware): `tests/curate-golden-eval.test.ts`,
  `tests/curate-metrics.test.ts`, `tests/deterministic-embedder.test.ts`,
  `scripts/akm-eval/bin/akm-eval-curate-bench` (see "Cross-Version Curate
  Benchmark" below)

## Goal

Future curate changes should prove that results are more relevant than the pinned
pre-change baseline, not just different.

## Run The Evals

Typecheck:

```sh
bunx tsc --noEmit
```

Curate-focused suite:

```sh
bun test \
  tests/curate-logic.test.ts \
  tests/curate-search-for-curation.test.ts \
  tests/curate-command.test.ts \
  tests/curate-relevance-eval.test.ts
```

Search regression safety net:

```sh
bun test tests/ranking-regression.test.ts
```

If you want the raw fixture outputs for manual inspection:

```sh
BUN_CONFIG_DISABLE_TRANSPILE_CACHE=1 bun -e "
import { loadFixtureStash } from './tests/fixtures/stashes/load.ts';
import { saveConfig } from './src/core/config/config.ts';
import { akmIndex } from './src/indexer/indexer.ts';
import { akmCurate } from './src/commands/read/curate.ts';

const loaded = loadFixtureStash('ranking-baseline', { skipIndex: true });
process.env.AKM_STASH_DIR = loaded.stashDir;
saveConfig({ semanticSearchMode: 'off', sources: [{ type: 'filesystem', path: loaded.stashDir }], registries: [] });
await akmIndex({ stashDir: loaded.stashDir, full: true });

for (const query of ['docker homelab', 'docker deploy', 'the docker', 'how docker', 'docker compose reference']) {
  const result = await akmCurate({ query, limit: 4 });
  console.log('\nQUERY', query);
  console.log(JSON.stringify(result.items.map((item) => ('ref' in item ? item.ref : `registry:${item.id}`)), null, 2));
}

loaded.cleanup();
"
```

## Current Pinned Before/After Cases

The fixture-backed eval currently proves these improvements over the old curate
behavior:

| Query | Before | After | Metric |
| --- | --- | --- | --- |
| `docker homelab` | root skill + child reference both consumed top-level slots | root skill only; child moved to `supportRefs` | family occupancy `2 -> 1` |
| `docker deploy` | included unrelated `command:release-manager` filler | no `release-manager` filler | banned filler count `1 -> 0` |
| `the docker` | no results | relevant docker results returned | result count `0 -> 2` |
| `how docker` | no results | relevant docker results returned | result count `0 -> 2` |

These are minimum guards, not the full product-quality bar.

## What To Preserve

- Broad family query: `docker homelab` -> `skill:docker-homelab`
- Narrow family query: `docker compose reference` -> `knowledge:skills/docker-homelab/references/compose`
- Prompt residue fallback: `the docker` should not return an empty list
- Weak-hit fallback: one weak phrase hit must not suppress stronger token results
- Explicit type filter: `--type` must still bypass diversification
- Registry results remain filler-only and capped

## Known Gotcha

Reference-query detection must use word boundaries.

Bad pattern:

```ts
/docs?/
```

That matches the `doc` substring inside `docker`, which incorrectly turns broad
docker queries into reference/doc queries.

Use the bounded pattern in `src/commands/read/curate.ts` instead:

```ts
const CURATE_REFERENCE_QUERY_RE = /\b(?:reference|docs?|guide|how|explain|learn|readme|why)\b/;
```

## Cross-Version Curate Benchmark (deterministic, rank-aware)

The fixture tests above run with `semanticSearchMode: "off"`, so they cannot
reproduce the **hybrid** ranking that production curate uses (FTS 0.7 + vector
0.3). That gap is exactly what let the "keyword leapfrog" bug ship: a
single-token FTS fallback hit (normalizes ~0.9) leapfrogged the contextual
full-query hits (~0.65 hybrid), and a semantic-off test cannot see it.

The deterministic curate benchmark closes that gap. It exercises the REAL
hybrid path reproducibly by holding the embedding axis constant.

### Pieces

- **Deterministic embedder** — `src/llm/embedders/deterministic.ts`, gated by
  `AKM_EMBED_DETERMINISTIC=1`. Feature-hashing (model-free, no download) used at
  BOTH index time and query time. Output is byte-stable across machines,
  runtimes, and akm source versions, so any score delta is attributable to
  source changes, not model drift. Off by default; never used in production.
- **Frozen corpus** — `tests/fixtures/stashes/curate-golden/` (16 synthetic
  assets, zero personal data) with deliberate trap patterns (a banned asset
  shares exactly one keyword with a query but is off-topic).
- **Hand-labeled judgments** — `curate-golden/judgments.json`: per query
  `relevant` (recall set), `idealOrder` (nDCG/MRR), and `banned` (the
  embedder-robust leapfrog gate). Labels are semantic ground truth, independent
  of what any akm version currently returns.
- **Rank-aware metrics** — `scripts/akm-eval/src/curate-metrics.ts`: nDCG@k,
  recall@k, MRR, and `noBannedAboveRequired` (the gate the leapfrog bug
  violated). Recall-only checks can't see ordering; these can.
- **CI guard** — `tests/curate-golden-eval.test.ts` seeds the corpus, scores
  every query in-process, and fails on a ranking regression or any leapfrog.
  Deterministic baseline: meanScore ≈ 0.890, leapfrogs = 0.
- **Embedding-axis drift guard** — `tests/deterministic-embedder.test.ts` pins a
  golden fingerprint of the embedder's output. If it changes, all historical
  bench numbers are incomparable — re-baseline deliberately, then update it.

### Compare two versions

`akm-eval-curate-bench` runs the golden suite through the real `akm` CLI and
diffs two binaries per case. The embedder is forced deterministic, so the diff
isolates source changes:

```sh
# Single scorecard for the current source
scripts/akm-eval/bin/akm-eval-curate-bench --akm "bun src/cli.ts"

# Compare two checkouts (baseline → candidate), fail on a >0.05 per-case drop
scripts/akm-eval/bin/akm-eval-curate-bench \
  --akm "bun /path/to/baseline/src/cli.ts" \
  --compare "bun src/cli.ts" \
  --fail-on-regression
```

Absolute scores reflect the deterministic embedder's crude (but fixed)
semantics and are NOT comparable to production. Their value is the cross-version
DELTA and the leapfrog gate, both of which are embedder-robust.

The precise unit-level guard for the leapfrog bug itself remains the
`mergeCurateSearchResponses` test in `tests/curate-logic.test.ts` (proven to
fail without the score cap).

## When Adding New Eval Cases

- Prefer fixture-backed queries in `ranking-baseline` when possible
- Add synthetic tests only when the fixture does not isolate the behavior cleanly
- Assert concrete refs or concrete metric deltas, not vague relevance claims
- Keep the eval deterministic; do not depend on semantic-search model downloads
- If you replace a pinned baseline, record the reason in the test file and in the PR
