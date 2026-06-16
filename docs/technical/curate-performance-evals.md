# Curate Performance Evals

Use this when tuning `akm curate` ranking, fallback, or family-collapsing behavior.

Related context:

- Implementation plan: `docs/0.9.0-curate-quality-implementation-plan.md`
- Workmap: `docs/agents/curate-workmap.md`
- Primary eval test: `tests/curate-relevance-eval.test.ts`
- Logic tests: `tests/curate-logic.test.ts`
- Fallback tests: `tests/curate-search-for-curation.test.ts`
- CLI behavior tests: `tests/curate-command.test.ts`

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

## When Adding New Eval Cases

- Prefer fixture-backed queries in `ranking-baseline` when possible
- Add synthetic tests only when the fixture does not isolate the behavior cleanly
- Assert concrete refs or concrete metric deltas, not vague relevance claims
- Keep the eval deterministic; do not depend on semantic-search model downloads
- If you replace a pinned baseline, record the reason in the test file and in the PR
