# Test I/O Seam Map (#664 follow-up)

**Thesis.** The Bun `--isolate` epoll fd race and the ~114s unit-suite runtime are
**the same symptom**: the production code has no I/O seams, so unit tests are
forced to stand up real OS resources (subprocesses, HTTP servers, on-disk SQLite
index builds). Real resources → fd churn → the race; real resources → slow.
Relocating spawns to `tests/integration/` (what we did first) *moves* the churn;
it does not eliminate it. Eliminating it means adding injection seams to the code
under test so the unit tier does **zero** real I/O — which simultaneously kills
the race (no fds to churn → `--parallel>1` becomes safe) and removes the per-file
cold-start tax (parallelism).

This document is the exhaustive map of every seam, traced from the test back to
the production line that forces the real resource.

---

## Seam #1 — Global `fetch` (no `fetchImpl` injection) · HIGHEST LEVERAGE

**Root line:** `src/core/common.ts:306` — `fetchWithTimeout` calls module-global
`fetch`; `fetchWithRetry` (`common.ts:326`) wraps it. **Neither takes a
`fetchImpl` argument.** Every networked subsystem funnels through here, so no test
can supply a fake response without a real socket.

Affected call sites (all lack injection):
- LLM client: `src/llm/client.ts:328` (`chatCompletionAttempt`). Options already
  expose `sleep` + `now` (`client.ts:248-257`) but **no `fetch`**.
- Embedder: `src/llm/embedders/remote.ts:49,92`. Ctor (`remote.ts:27`) takes only
  config, no fetch.
- Registry providers: `static-index.ts:230`, `skills-sh.ts:192`,
  `build-index.ts:294,416`. `createProvider`/`provider.search` take only config.

### Tests forced onto real `Bun.serve` because of this seam (~26 servers / ~17 files)

| test file | servers | subsystem | becomes pure with injected fetch? |
|---|---|---|---|
| `tests/llm-client.test.ts` | 2 | `chatCompletion` | yes (parsing/redaction/retry-class pure) |
| `tests/llm.test.ts` | 2 | llm facade | yes |
| `tests/llm-enrichment-cache.test.ts` | 1 | enrichment over llm | partial (cache logic pure) |
| `tests/graph-extraction.test.ts` | 1 | graph-extract → llm | **yes** (batch/array-salvage parsing pure) |
| `tests/graph-extract-batch.test.ts` | 1 | graph-extract | yes |
| `tests/graph-extraction-batch.test.ts` | 1 | graph-extract | yes |
| `tests/graph-lazy-show-curate.test.ts` | 1 | graph-extract | partial |
| `tests/embedder.test.ts` | 5 | `RemoteEmbedder` | **yes** (L2-norm/endpoint/batch-order pure) |
| `tests/embedding-model-config.test.ts` | 2 | embedder model-id | partial (`resolveEmbeddingModelId` already pure) |
| `tests/registry-search.test.ts` | 2 | `searchRegistry` | **yes** (scoring `scoreKits/scoreStash` pure) |
| `tests/registry-index-v2.test.ts` | 1 | index parse | yes (`parseRegistryIndex` pure) |
| `tests/registry-cli.test.ts` | 1 | registry CLI | partial |
| `tests/registry-build-index.test.ts` | 1 | crawler | partial (assembly pure; pagination = integration) |
| `tests/registry-providers/skills-sh.test.ts` | 3 | skills-sh provider | yes (mapping fns pure) |
| `tests/registry-providers/static-index.test.ts` | 1 | static-index provider | yes |
| `tests/registry-providers/parity.test.ts` | 1 | both providers | partial |
| `tests/commands/search.test.ts` | 1 | search + embedder | partial |
| `tests/commands/show-indexer-parity.test.ts` | 1 | show vs index | partial |

Genuinely transport-shaped (keep one thin integration test each, do **not**
de-socket the assertion): `tests/integration/add-website-source.test.ts`,
`tests/source-qa-fixes.test.ts` (website crawl), `registry-build-index` pagination.

**Fix:** add optional `fetchImpl` to `fetchWithTimeout`/`fetchWithRetry`
(`common.ts:288,326`); thread an injectable `fetch` through
`ChatCompletionInternalOptions`, the `RemoteEmbedder` ctor, and the provider
factory. Scoring/parsing tests should bypass HTTP entirely by calling the pure
functions (`scoreKits`, `parseRegistryIndex`, `parseSkillsResponse`,
`normalizeEmbeddingEndpoint`, `l2Normalize`) directly.

### Sub-seam #1b — registry cache is a shared-`index.db` table

The registry cache is **not** a per-URL file — it's the `registry_index_cache`
table inside the shared index DB (`db.ts:2574,2602`), opened via
`withRegistryCacheDb` → `openDatabase()` with **no argument**
(`static-index.ts:182`, `skills-sh.ts:47`). So even with injected fetch, provider
tests still touch a real DB. To make them fully pure, `withRegistryCacheDb` (or
the provider ctor) needs an injectable cache interface (`get(key,ttl)` /
`upsert(key,json)`).

---

## Seam #2 — improve planner reads the real `entries` table · KILLS ~20 INDEX BUILDS

**Root line:** `src/commands/improve/improve.ts:664-665` —
`openExistingDatabase()` then `getAllEntries(db, …)` (SQL at `db.ts:1673`,
`SELECT … FROM entries`). The planner needs **only the `entries` table** — not
FTS, not vectors — yet tests populate it with a full FTS rebuild via
`akmIndex({full:true})` and then neutralize the refresh with
`ensureIndexFn: async () => false`.

**The seam already exists and is unused:** `options.collectEligibleRefsFn`
(`improve.ts:297-298`, resolved `improve.ts:1103`) lets a caller return
`ImproveEligibleRef[]` directly and bypass the DB entirely. **Only
`tests/commands/improve/improve-multi-cycle.test.ts` uses it** (and it calls no
`akmIndex`). Every other improve test rebuilds the index unnecessarily.

Improve tests that should route through `collectEligibleRefsFn` (or a
`seedEntries(rows)` helper that writes the `entries` table directly), dropping
their `akmIndex` call:

`improve-triage-prepass` (7×), `improve-sync` (7×), `consolidate-min-pool-size`
(4×), `improve-memory` (3×), `improve-memory-misc`, `improve-eligibility`,
`improve-planner-profile-prefilter`, `salience-wiring`, `outcome-loop-wiring`,
`improve-dry-run-side-effects`, `improve-planned-filepath`, `improve-no-hang`,
`improve-path-exists-guard`, `improve-recombine(-promote)`, `improve-procedural`,
`improve-related-sessions`, `improve-reflect-unsupported-type-skip`,
`improve-distill-planner-skip-lessons`, `proactive-maintenance-flow`.

**Keep building the index (the indexer/DB IS the subject):**
`integration/indexer`, `integration/e2e`, `workflows/indexer-rejection`,
`index-clean`, `issue-36-repro`, `session-indexing`, `secret-indexing`,
`show-indexer-parity`, `improve-ensure-index-first` (tests the ordering),
`improve-db-locking` (lock is the SUT).

---

## Seam #3 — search/curate have NO data-source seam · use shared `beforeAll` fixture

`akmSearch` (`src/commands/read/search.ts:22`) → `searchLocal`
(`db-search.ts:278` `getAllEntries`) reads the real FTS + `entries` DB and has
**no** injection point. So scoring/search/curate/manifest/ranking tests must
`akmIndex` first. With no seam to add cheaply, the lever is a **single
`beforeAll`-built indexed fixture** per file instead of per-test rebuilds. The
`tests/fixtures/stashes/load.ts` helper already does one in-process build (now via
`akmIndex`, post-#664) — expand its use.

Files rebuilding a full index for what is effectively one read: `source` (4×),
`scoring-pipeline` (5×), `commands/search` (4×), `commands/history` (4×),
`scope-flags` (6×), `curate-search-for-curation` (3×), plus the ranking /
utility-scoring / proposed-quality / parallel-search / manifest / feedback-command
/ lessons-coverage cluster (1 each).

---

## Seam #4 — stdin shim (the one missing CLI seam) · the rest are real boundaries

The in-process CLI harness works: `main` is exported (`src/cli.ts:500`) and all
startup side effects are guarded by `if (import.meta.main || AKM_NODE_ENTRY)`
(`cli.ts:607`), so `runCliCapture` (`tests/_helpers/cli.ts`) drives it and
monkey-patches `process.stdout/stderr/exit`. **stdout/stderr/exit are
injectable** (via global patch). **stdin is NOT** — commands read it directly
(`secret set`, `env create --from-stdin`, `remember` no-body, `import -` via
`fs.readFileSync(0)`). That is the single seam worth adding to retire the stdin
spawns.

| keep as subprocess (genuine boundary / inherent) | migrate to `runCliCapture` now | migrate after a harness fix |
|---|---|---|
| `env run` / `secret run` (stdout inherited to real fd — grandchild) | `output-baseline-graph`, `distill-cli-flag`, 3 non-help `e2e` call sites, `wiki`, `add-website-source` (keep its local server) | `improve-cli-flags` + `improve-result-to-file` (need per-call DB isolation in the harness, not a real boundary) |
| stdin tests (`secret`, `remember-frontmatter`, `capture-cli`, `env create`) | | `completions --install` (needs `warn()`→stderr captured under preload) |
| `git`/`tar`/`docker`/`bash` installer, `process.exit(143)` lock test, `sleep 5` foreign-PID lock | | `events @offset` (needs cross-process cursor seeded via fs) |

Inherent real-process files belong in `tests/integration/` permanently:
`write-source` (git), `save-command` (git half), `git-source-safety`,
`source-providers/git`, `docker-install`, `install-script`, `registry-install`
(tar/git), `walker` (git init), `tar-utils-scan`, `file-lock`,
`index-writer-lock`, `node-compat`, `ripgrep-install`.

---

## Seam #5 — injectable clock on `tailEvents` + improve duration bookends

Two genuine non-subprocess wall-clock waits remain (everything else is already
virtualized via injected `setTimeoutFn`, or is a legitimate subprocess
kill-watchdog):

| file:line | wait | fix |
|---|---|---|
| `tests/commands/events.test.ts:248,250,268,290` | real `setTimeout` for the events tail/cursor | add `nowFn`/`sleepFn` to `tailEvents` (model: `client.ts:177/250/256`) |
| `improve-budget-watchdog.test.ts:81`, `improve-reflect-unsupported-type-skip.test.ts:330,351` | real sleep so `*DurationMs` is non-zero | inject `now()` into the improve `Date.now()` bookends; assert virtual delta |
| `tests/llm-usage-telemetry.test.ts:99` | `setTimeout(r,0)` yield | `await Promise.resolve()` |

Reference patterns that already do this right: `extract-watch.test.ts:52-56`,
`opencode-sdk-runner.test.ts:156`, `reflect-propose.test.ts:283`.

---

## Seam #6 — isolation debt (raw `mkdtempSync` + `process.env` mutation)

`scripts/lint-tests-isolation.ts` ratchet baseline = **64**, and the live combined
allowlist is **exactly 64** (`ENV_ASSIGN_ALLOWED` 3 + `ALLOWED_FILES` 61) — i.e.
maxed out, every grandfathered file is one un-migrated isolation hazard *and* a
scattered temp-dir source. Migrating these onto `withIsolatedAkmStorage` /
`makeStashDir` (the only sanctioned AKM-temp minting home,
`tests/_helpers/sandbox.ts`) fixes latent cross-file pollution **and** consolidates
`mkdtempSync` churn. Top temp-dir offenders: `source-source` (13),
`setup-tmp-stash-guard` (10), `setup-from-file` (8), `detect-environment` (7),
`commands/graph` (6).

---

## Execution order (ROI-ranked)

1. **Seam #1 — `fetchImpl` injection.** One change to `common.ts` + thread it
   through llm/embedder/providers. Collapses ~26 `Bun.serve` instances across ~17
   files into pure tests. Biggest fd-churn + runtime win; also the clearest
   `--parallel>1` unblocker. Add `+ #1b` (cache injection) for the registry
   providers.
2. **Seam #2 — route improve tests through `collectEligibleRefsFn` / `seedEntries`.**
   Kills ~20 full FTS rebuilds (~250ms each). Seam already exists; near-zero risk.
3. **Seam #3 — `beforeAll` shared index** for search/curate/scoring files.
4. **Seam #4 — stdin shim** in `runCliCapture`, then migrate the category-B CLI
   spawns; relocate inherent-process files to `tests/integration/`.
5. **Seam #5 — clock injection** on `tailEvents` + improve bookends.
6. **Seam #6 — drive the isolation ratchet 64 → ~5.**

## Guardrails (lint, so it can't regress)

Extend `scripts/lint-tests-isolation.ts`:
- No real `spawnSync`/`Bun.spawn`/`Bun.serve` in a file outside `tests/integration/`
  (codifies the boundary we now enforce by hand).
- No `akmIndex({full:true})` inside a `test()`/`it()` body (force into `beforeAll`
  or the `collectEligibleRefsFn` seam).

## The payoff

Seams #1–#3 turn the bulk of the unit tier pure → no spawns/servers/index builds
→ the epoll race has nothing to churn → `TEST_PARALLEL>1` becomes safe → the
~100s of per-file Bun cold-start (368 files × ~270ms) collapses under parallelism.
That is the only path from "make the real-I/O tests faster" to "the unit tier is
actually fast and the race is gone."
