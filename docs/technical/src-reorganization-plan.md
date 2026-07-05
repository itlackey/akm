# AKM `src/` Reorganization Plan — Architectural Decision

**Status:** PARTIALLY EXECUTED (2026-06, D-series) — `commands/improve/`, `commands/proposal/`, `commands/graph/`, `commands/env/` slices moved; kernel/indexer nesting still pending.
**Branch context:** `release/0.9.0`, post-#490 (COMPLETE — the #490 refactor outcome is recorded in project memory, not a repo doc)
**Author role:** Lead architect adjudication of three proposed layouts (A: pure vertical slice, B: refined layered, C: pragmatic hybrid)
**Supersession note (2026-07-05, meta-review 14):** the indexer half of this plan is SUPERSEDED by `docs/analysis/indexer-vertical-slice-refactor-plan.md` (2026-07-03). The non-indexer kernel guidance remains current.

---

## 1. Executive Summary + Recommended Target Structure

### Decision

**Adopt Proposal C (Pragmatic Hybrid), with two amendments borrowed from B and A.** The recommended structure draws a single, reviewer-enforceable line between a **layered shared kernel/engine zone** and a small set of **promoted vertical feature slices**. It is a *relocation codemod*, never a re-slice — behaviour stays byte-identical.

The owner asked for: more nesting, vertical slices where possible, FS mirrors architecture, maintainability — under hard constraints: behaviour-identical, build-on-#490 (no `src/services/` layer), test-isolation + MPL headers stay green, phased + low-churn. The hybrid is the only one of the three that satisfies *all four* owner goals while respecting *all four* hard constraints without paying a cohesion or churn penalty it cannot justify.

### The recommended target top-level shape

```
src/
  cli.ts                 # composition root (~620 LOC) — UNMOVED (#490)
  cli/                   # citty composition helpers — UNMOVED (#490)
  globals.d.ts           # MPL-exempt — UNMOVED

  # ── ZONE B: vertical feature slices (screaming architecture) ──
  commands/
    improve/             # SLICE 1: knowledge evolution (largest, cheapest)
    proposal/            # SLICE 2: proposal queue (extends existing nest)
    sources/             # SLICE 5: source/stash lifecycle command surface
    env/                 # SLICE 6: env/secret
    read/                # SLICE 3: search/show/curate read path
    graph/               # SLICE 4: graph command surface
    tasks/               # scheduled-task command surface
    agent/               # contribute/agent command surface
    health/  lint/       # existing nests — kept
    <thin leaf *-cli.ts> # config-cli, db-cli, registry-cli, wiki-cli,
                         #   workflow-cli, feedback-cli, observability-cli,
                         #   completions, url-checker — stay FLAT

  # ── ZONE A: shared kernel + engines (layered, by technical concern) ──
  core/                  # kernel primitives at root; config/ + asset/ nested
  indexer/               # engine, nested BY PIPELINE PHASE (walk/db/graph/search/passes/usage)
  output/                # #490 shapes/ + text/ registries — UNMOVED
  storage/               # #490 locations/engines/repositories — UNMOVED
  llm/                   # bounded stateless seam — UNMOVED (guard tests pin it)
  integrations/          # agent spawn seam — UNMOVED (guard tests pin it)
  registry/  sources/  setup/  tasks/  wiki/   # capability ENGINES — UNMOVED
  workflows/             # already cohesive SLICE 7 — light internal grouping only
```

### Two amendments to Proposal C

1. **Feature slices nest *inside* `commands/`, not at a new top-level `src/features/`** (this is C's posture, sharpened against A). Promoting `src/features/` (Proposal A) would relocate the `*-cli.ts` citty seam *out of* `commands/`, which is exactly the seam #490 established and named. Keeping slices under `commands/<family>/` means each `*-cli.ts` keeps its name and its directory ancestry — the #490 seam is preserved verbatim, and the CLI surface stays byte-identical by construction. We get the screaming benefit (a newcomer reads `commands/improve/`, `commands/proposal/`, `commands/sources/`…) without paying A's seam-relocation risk.

2. **The line between slice and kernel is the explicit, testable rule from C** (borrowing B's churn discipline): a file is promoted into a feature slice **only if** (a) its external importer count is low (≤~3 outside the slice), **and** (b) it changes for that capability's reason (CCP), **and** (c) moving it does not drag a high-fan-in kernel module or expose an import cycle. Everything failing any clause stays layered. This is what keeps `config` (82), `errors` (76), `common` (57), `paths` (35), `asset-ref` (29) in the kernel even though "improve uses them."

### Why this beat the other two (the debate resolution)

- **vs Proposal A (pure vertical slice):** A is the most aesthetically "screaming" but it (i) relocates the `*-cli.ts` seam out of `commands/` into `src/features/`, churning the one seam #490 just stabilized; (ii) is *forced* to give the indexer engine a feature folder (`features/indexing/`) — A's own self-critique admits this is "a slight category error" because the indexer is a *pipeline reused by improve/search/graph*, i.e. infrastructure, not a capability; (iii) creates feature→feature horizontal edges (env-secret→search, improve→graph) that A must hand-resolve with dependency injection or kernel demotion. A's churn-cost self-score (6) and the ~200-file test-mirror blast radius confirm it is the highest-risk option. We **keep A's strongest idea** — promote the genuinely cohesive `improve`/`proposal` slices first — but reject its over-reach (slicing the engine, moving the seam).

- **vs Proposal B (refined layered):** B is the lowest-churn and highest #490-fit (it scores itself 9/10 churn, 10/10 fit), but it explicitly *declines* the owner's "vertical slices where possible" goal: it keeps `core/proposals/` and `core/memory/` in `core/`, so the "knowledge evolution" capability stays physically split across `commands/`, `core/`, `output/`, `indexer/`, `llm/`. B's own self-critique lists this first under "what it makes worse." B is correct that the *engine* and *kernel* must stay layered — and we adopt B's `indexer/`-by-pipeline-phase and `core/{config,asset}/` nesting wholesale — but B under-delivers on the explicit owner goal of vertical slices. We **keep B's nesting discipline and barrel policy**, but go one step further by lifting the 5–6 low-fan-in capability slices B leaves on the table.

- **Why C wins:** C is the synthesis the literature itself recommends — "each feature owns its domain/adapters while a thin shared layer underneath stays layered — practicality over purity" (Shingler; Bogard). It draws the slice/kernel line *by the CCP/CRP + fan-in numbers*, which is objective and reviewer-enforceable, not a matter of taste. It hits every owner goal (nesting via the kernel/engine nests; vertical slices via the 5–6 promoted capabilities; FS-mirrors-architecture via the doc reconciliation in §4; maintainability via per-slice cohesion) while honoring every hard constraint. The amendments above remove C's only real ambiguity (where slices live) by binding them to `commands/`.

---

## 2. Current Pain Inventory (offender dirs + latent slices)

Verified at HEAD on `release/0.9.0`:

| Dir | Count | Pain |
| --- | --- | --- |
| `src/commands/` | 62 flat `.ts` files + 3 subdirs (`health/`, `lint/`, `proposal/`); 20 are `*-cli.ts` | Conflates three kinds of file: thin citty `*-cli.ts` adapters, large backing engines (`improve.ts` 3,396 LOC, `consolidate.ts` 2,694, `distill.ts` 1,639, `health.ts` 1,992), and per-asset helpers. `improve.ts` sits alphabetically between `info.ts` and `init.ts`. |
| `src/core/` | 37 flat `.ts` files + `ripgrep/` | Mixes a genuine shared kernel (`errors` 76 importers, `common` 57, `events` 24) with incidental flat clusters: `config-*` ×7 (config.ts = **82 importers**, highest in repo), `asset-*` ×8, the `proposal*` 3-file cycle, the `memory-*` improve-bound trio. |
| `src/indexer/` | 30 flat `.ts` files, no subdirs | A pipeline (walk → classify → rank → search → db) dumped flat. `db.ts` 2,243 LOC (15 importers), `indexer.ts` 1,922 LOC (11 importers). |
| `src/workflows/` | 13 files | Already cohesive; only needs light authoring-vs-runtime grouping. |

**Verified facts that shape the plan:**
- `tsconfig.json` has **no `paths` key** today; `moduleResolution: "Bundler"`. Phase 0 (add coarse aliases) is therefore greenfield.
- `state-db.ts:57` imports `type AkmImproveResult from "../commands/improve"` — a real commands↔core type cycle (state-db has 7 importers; foundational).
- `env-secret-ref.ts:17` imports `resolveSourceEntries` from `../indexer/search-source` — a real core→indexer edge.
- `memory-contradiction-detect.ts:40-41` imports `../llm/client` + `../llm/feature-gate` — a real core→llm edge.
- `core/proposals.ts` + `proposal-validators.ts` + `proposal-quality-validators.ts` form a real 3-file intra-cycle.
- **CRITICAL — the test-isolation allowlist (`scripts/lint-tests-isolation.ts`) uses PINNED PATHS, not globs** (e.g. `"tests/paths.test.ts"`, `"tests/commands/search.test.ts"`). Confirmed at HEAD. Any `tests/**` move **must** update the allowlist entry in the same commit or `bun run lint` fails. This is the single most important migration hazard and overrides the dossier's "verify globs" note — the answer is *not* globs.

### Latent vertical slices (files scattered across layers, change together)

- **SLICE 1 — IMPROVE / knowledge evolution (~10k LOC, dominant):** `commands/{improve, consolidate, distill, distill-promotion-policy, extract, extract-prompt, reflect, improve-auto-accept, improve-profiles, improve-result-file, eval-cases, improve-cli, extract-cli}` + `core/{memory-belief, memory-contradiction-detect, memory-improve}` + (indexer-side passes stay in the engine — see §4) + `output/{shapes,text}/{distill,curate}`. `improve.ts` already directly imports 8–12 of these; backing modules have **0–1 external importers**.
- **SLICE 2 — PROPOSAL queue:** `commands/{proposal, proposal-cli, propose, proposal/drain, proposal/drain-policies}` + the `core/proposal*` 3-file cycle (move as one unit) + `output/{shapes,text}/proposal-*`.
- **SLICE 3 — SEARCH/SHOW read path:** `commands/{search, search-cli, show, curate, registry-search, knowledge, remember-cli}` (the indexer read-engine stays put).
- **SLICE 4 — GRAPH:** `commands/{graph, graph-cli}` (graph engine stays in `indexer/graph/`).
- **SLICE 5 — SOURCE/STASH lifecycle:** `commands/{source-add, source-clone, source-manage, sources-cli, add-cli, installed-stashes, stash-cli, stash-skeleton, init, info, self-update, history, schema-repair, migration-help}` (the `src/sources/` provider engine stays put).
- **SLICE 6 — ENV/SECRET:** `commands/{env, env-cli, secret, secret-cli}` (`core/env-secret-ref.ts` stays in core — cycle).
- **SLICE 7 — WORKFLOW:** already cohesive `src/workflows/` (13 files).

---

## 3. Concrete TARGET `src/` Tree + Old→New Mapping

Notation: `(NEW)` = new dir; `[barrel]` = high-fan-in module gets a same-path re-export shim or coarse alias to keep call sites byte-diff-free.

```
src/
├── cli.ts                          # UNMOVED
├── cli/                            # UNMOVED
├── globals.d.ts                    # UNMOVED (MPL-exempt)
│
├── commands/                       # *-cli.ts seam layer + per-family slice folders
│   ├── improve/        (NEW)       # SLICE 1
│   ├── proposal/       (extends)   # SLICE 2
│   ├── sources/        (NEW)       # SLICE 5
│   ├── env/            (NEW)       # SLICE 6
│   ├── read/           (NEW)       # SLICE 3
│   ├── graph/          (NEW)       # SLICE 4
│   ├── tasks/          (NEW)       # task command surface
│   ├── agent/          (NEW)       # contribute/agent surface
│   ├── health/         (extends)   # health.ts + checks/ (#490 WS9)
│   ├── lint/           (UNCHANGED) # cleanest existing nest — the template
│   └── <flat leaves>               # config-cli, db-cli, registry-cli, wiki-cli,
│                                   #   workflow-cli, feedback-cli, observability-cli,
│                                   #   events, completions, url-checker, lesson-lint
│
├── core/                           # ZONE A kernel — primitives at root, two nests
│   ├── errors.ts common.ts events.ts          # NEVER MOVE (76/57/24)
│   ├── concurrent.ts parse.ts time.ts tty.ts warn.ts text-truncation.ts write-source.ts
│   ├── file-lock.ts state-db.ts paths.ts       # storage primitives (paths 35 — defer)
│   ├── env-secret-ref.ts                       # STAYS (indexer edge)
│   ├── action-contributors.ts lesson-lint.ts
│   ├── config/         (NEW)  config.ts[barrel] io/migration/schema/sources/types/walker
│   ├── asset/          (NEW)  spec ref create registry serialize frontmatter markdown stash-meta
│   └── ripgrep/                                # UNCHANGED
│
├── indexer/                        # ZONE A engine — BY PIPELINE PHASE
│   ├── indexer.ts[barrel] ensure-index.ts manifest.ts
│   ├── walk/    (NEW)  walker matchers path-resolver file-context index-context project-context
│   ├── db/      (NEW)  db.ts[barrel] db-backup graph-db llm-cache
│   ├── graph/   (NEW)  graph-boost graph-dedup graph-extraction
│   ├── search/  (NEW)  db-search ranking ranking-contributors search-fields
│   │                   search-hit-enrichers semantic-status search-source
│   ├── passes/  (NEW)  memory-inference staleness-detect pass-context metadata metadata-contributors
│   └── usage/   (NEW)  usage-events unmigrated-vaults-guard
│
├── output/      storage/      llm/      integrations/    # UNMOVED
├── registry/    sources/      setup/    tasks/   wiki/    # ENGINES — UNMOVED
└── workflows/                       # SLICE 7 — light authoring/ + runtime/ grouping
```

### Old-path → new-path mapping (commands / core / indexer / workflows)

**commands/ — IMPROVE (SLICE 1)**

| Old | New |
| --- | --- |
| `src/commands/improve-cli.ts` | `src/commands/improve/improve-cli.ts` |
| `src/commands/improve.ts` | `src/commands/improve/improve.ts` |
| `src/commands/consolidate.ts` | `src/commands/improve/consolidate.ts` |
| `src/commands/distill.ts` | `src/commands/improve/distill.ts` |
| `src/commands/distill-promotion-policy.ts` | `src/commands/improve/distill-promotion-policy.ts` |
| `src/commands/extract.ts` | `src/commands/improve/extract.ts` |
| `src/commands/extract-cli.ts` | `src/commands/improve/extract-cli.ts` |
| `src/commands/extract-prompt.ts` | `src/commands/improve/extract-prompt.ts` |
| `src/commands/reflect.ts` | `src/commands/improve/reflect.ts` |
| `src/commands/improve-auto-accept.ts` | `src/commands/improve/improve-auto-accept.ts` |
| `src/commands/improve-profiles.ts` | `src/commands/improve/improve-profiles.ts` |
| `src/commands/improve-result-file.ts` | `src/commands/improve/improve-result-file.ts` |
| `src/commands/eval-cases.ts` | `src/commands/improve/eval-cases.ts` |
| `src/core/memory-belief.ts` | `src/commands/improve/memory/memory-belief.ts` |
| `src/core/memory-improve.ts` | `src/commands/improve/memory/memory-improve.ts` |
| `src/core/memory-contradiction-detect.ts` | `src/commands/improve/memory/memory-contradiction-detect.ts` |

**commands/ — PROPOSAL (SLICE 2)** — move the core 3-cycle as ONE unit

| Old | New |
| --- | --- |
| `src/commands/proposal-cli.ts` | `src/commands/proposal/proposal-cli.ts` |
| `src/commands/proposal.ts` | `src/commands/proposal/proposal.ts` |
| `src/commands/propose.ts` | `src/commands/proposal/propose.ts` |
| `src/commands/proposal/drain.ts` | `src/commands/proposal/drain.ts` (already nested) |
| `src/commands/proposal/drain-policies.ts` | `src/commands/proposal/drain-policies.ts` (already nested) |
| `src/core/proposals.ts` | `src/commands/proposal/validators/proposals.ts` `[barrel @ core/proposals.ts; 13 sites]` |
| `src/core/proposal-validators.ts` | `src/commands/proposal/validators/proposal-validators.ts` |
| `src/core/proposal-quality-validators.ts` | `src/commands/proposal/validators/proposal-quality-validators.ts` |

**commands/ — SOURCES (5), ENV (6), READ (3), GRAPH (4), TASKS, AGENT**

| Old | New |
| --- | --- |
| `src/commands/sources-cli.ts` | `src/commands/sources/sources-cli.ts` |
| `src/commands/add-cli.ts` | `src/commands/sources/add-cli.ts` |
| `src/commands/stash-cli.ts` | `src/commands/sources/stash-cli.ts` |
| `src/commands/source-add.ts` | `src/commands/sources/source-add.ts` |
| `src/commands/source-clone.ts` | `src/commands/sources/source-clone.ts` |
| `src/commands/source-manage.ts` | `src/commands/sources/source-manage.ts` |
| `src/commands/installed-stashes.ts` | `src/commands/sources/installed-stashes.ts` |
| `src/commands/stash-skeleton.ts` | `src/commands/sources/stash-skeleton.ts` |
| `src/commands/init.ts` | `src/commands/sources/init.ts` |
| `src/commands/info.ts` | `src/commands/sources/info.ts` |
| `src/commands/self-update.ts` | `src/commands/sources/self-update.ts` |
| `src/commands/history.ts` | `src/commands/sources/history.ts` |
| `src/commands/schema-repair.ts` | `src/commands/sources/schema-repair.ts` |
| `src/commands/migration-help.ts` | `src/commands/sources/migration-help.ts` |
| `src/commands/env-cli.ts` | `src/commands/env/env-cli.ts` |
| `src/commands/env.ts` | `src/commands/env/env.ts` |
| `src/commands/secret-cli.ts` | `src/commands/env/secret-cli.ts` |
| `src/commands/secret.ts` | `src/commands/env/secret.ts` |
| `src/commands/search-cli.ts` | `src/commands/read/search-cli.ts` |
| `src/commands/search.ts` | `src/commands/read/search.ts` |
| `src/commands/show.ts` | `src/commands/read/show.ts` |
| `src/commands/curate.ts` | `src/commands/read/curate.ts` |
| `src/commands/registry-search.ts` | `src/commands/read/registry-search.ts` |
| `src/commands/knowledge.ts` | `src/commands/read/knowledge.ts` |
| `src/commands/remember-cli.ts` | `src/commands/read/remember-cli.ts` |
| `src/commands/graph-cli.ts` | `src/commands/graph/graph-cli.ts` |
| `src/commands/graph.ts` | `src/commands/graph/graph.ts` |
| `src/commands/tasks-cli.ts` | `src/commands/tasks/tasks-cli.ts` |
| `src/commands/tasks.ts` | `src/commands/tasks/tasks.ts` |
| `src/commands/default-tasks.ts` | `src/commands/tasks/default-tasks.ts` |
| `src/commands/contribute-cli.ts` | `src/commands/agent/contribute-cli.ts` |
| `src/commands/agent-dispatch.ts` | `src/commands/agent/agent-dispatch.ts` |
| `src/commands/agent-support.ts` | `src/commands/agent/agent-support.ts` |

**Stay FLAT in `commands/` (thin leaves fronting a kernel/engine layer; foldering = one-file ceremony):** `config-cli.ts`, `db-cli.ts`, `registry-cli.ts`, `wiki-cli.ts`, `workflow-cli.ts`, `feedback-cli.ts`, `observability-cli.ts`, `events.ts`, `completions.ts`, `url-checker.ts`, `lesson-lint.ts`.

**core/**

| Old | New |
| --- | --- |
| `src/core/config.ts` | `src/core/config/config.ts` `[barrel @ core/config.ts; 82 sites]` |
| `src/core/config-io.ts` | `src/core/config/config-io.ts` |
| `src/core/config-migration.ts` | `src/core/config/config-migration.ts` |
| `src/core/config-schema.ts` | `src/core/config/config-schema.ts` |
| `src/core/config-sources.ts` | `src/core/config/config-sources.ts` |
| `src/core/config-types.ts` | `src/core/config/config-types.ts` |
| `src/core/config-walker.ts` | `src/core/config/config-walker.ts` |
| `src/core/asset-spec.ts` | `src/core/asset/asset-spec.ts` `[barrel; 23 sites]` |
| `src/core/asset-ref.ts` | `src/core/asset/asset-ref.ts` `[barrel; 29 sites]` |
| `src/core/asset-create.ts` | `src/core/asset/asset-create.ts` |
| `src/core/asset-registry.ts` | `src/core/asset/asset-registry.ts` |
| `src/core/asset-serialize.ts` | `src/core/asset/asset-serialize.ts` |
| `src/core/frontmatter.ts` | `src/core/asset/frontmatter.ts` `[barrel; 18 sites]` |
| `src/core/markdown.ts` | `src/core/asset/markdown.ts` |
| `src/core/stash-meta.ts` | `src/core/asset/stash-meta.ts` |
| `src/core/{errors,common,events,...}.ts` | UNMOVED (kernel root) |
| `src/core/paths.ts` (35) · `state-db.ts` (7) · `env-secret-ref.ts` · `file-lock.ts` | UNMOVED (kernel root; see §4 cycles + deferred `paths`→storage) |

**indexer/**

| Old | New |
| --- | --- |
| `src/indexer/indexer.ts` | `src/indexer/indexer.ts` (stays at root) `[barrel/alias; 11 sites]` |
| `src/indexer/ensure-index.ts` | `src/indexer/ensure-index.ts` (root) |
| `src/indexer/manifest.ts` | `src/indexer/manifest.ts` (root) |
| `src/indexer/walker.ts` | `src/indexer/walk/walker.ts` |
| `src/indexer/matchers.ts` | `src/indexer/walk/matchers.ts` |
| `src/indexer/path-resolver.ts` | `src/indexer/walk/path-resolver.ts` |
| `src/indexer/file-context.ts` | `src/indexer/walk/file-context.ts` |
| `src/indexer/index-context.ts` | `src/indexer/walk/index-context.ts` |
| `src/indexer/project-context.ts` | `src/indexer/walk/project-context.ts` |
| `src/indexer/db.ts` | `src/indexer/db/db.ts` `[barrel; 15 sites]` |
| `src/indexer/db-backup.ts` | `src/indexer/db/db-backup.ts` |
| `src/indexer/graph-db.ts` | `src/indexer/db/graph-db.ts` |
| `src/indexer/llm-cache.ts` | `src/indexer/db/llm-cache.ts` |
| `src/indexer/graph-boost.ts` | `src/indexer/graph/graph-boost.ts` |
| `src/indexer/graph-dedup.ts` | `src/indexer/graph/graph-dedup.ts` |
| `src/indexer/graph-extraction.ts` | `src/indexer/graph/graph-extraction.ts` |
| `src/indexer/db-search.ts` | `src/indexer/search/db-search.ts` |
| `src/indexer/ranking.ts` | `src/indexer/search/ranking.ts` |
| `src/indexer/ranking-contributors.ts` | `src/indexer/search/ranking-contributors.ts` |
| `src/indexer/search-fields.ts` | `src/indexer/search/search-fields.ts` |
| `src/indexer/search-hit-enrichers.ts` | `src/indexer/search/search-hit-enrichers.ts` |
| `src/indexer/semantic-status.ts` | `src/indexer/search/semantic-status.ts` |
| `src/indexer/search-source.ts` | `src/indexer/search/search-source.ts` |
| `src/indexer/memory-inference.ts` | `src/indexer/passes/memory-inference.ts` |
| `src/indexer/staleness-detect.ts` | `src/indexer/passes/staleness-detect.ts` |
| `src/indexer/pass-context.ts` | `src/indexer/passes/pass-context.ts` |
| `src/indexer/metadata.ts` | `src/indexer/passes/metadata.ts` |
| `src/indexer/metadata-contributors.ts` | `src/indexer/passes/metadata-contributors.ts` |
| `src/indexer/usage-events.ts` | `src/indexer/usage/usage-events.ts` |
| `src/indexer/unmigrated-vaults-guard.ts` | `src/indexer/usage/unmigrated-vaults-guard.ts` |

**workflows/** (lightest touch — already cohesive)

| Old | New |
| --- | --- |
| `src/workflows/authoring.ts` | `src/workflows/authoring/authoring.ts` |
| `src/workflows/scope-key.ts` | `src/workflows/authoring/scope-key.ts` |
| `src/workflows/runs.ts` | `src/workflows/runtime/runs.ts` |
| `src/workflows/checkin.ts` | `src/workflows/runtime/checkin.ts` |
| `src/workflows/document-cache.ts` | `src/workflows/runtime/document-cache.ts` |
| `src/workflows/agent-identity.ts` | `src/workflows/runtime/agent-identity.ts` |
| `src/workflows/{cli,parser,renderer,validator,validate-summary,schema,db}.ts` | UNMOVED (workflow root) |

`storage/repositories/workflow-runs-repository.ts` STAYS in `storage/` (#490 repo layer). `commands/workflow-cli.ts` stays flat.

---

## 4. Vertical Slice vs Retained Layered Kernel — Where the Line Is Drawn and Why

The line mirrors **architecture.md's Module Boundaries** (the as-built map, which #490 designates authoritative over v1-spec §7).

**VERTICAL SLICES (Zone B) — promoted to `commands/<family>/`:** improve, proposal, sources, env, read, graph, tasks, agent. Each is a *command-family capability* whose backing modules have low external fan-in and change together for one user-facing reason. The `*-cli.ts` adapter sits beside the logic it already calls.

**RETAINED LAYERED (Zone A) — kept by technical concern, nested but not sliced:**
- **Shared kernel** (`core/` primitives): `errors` (76), `common` (57), `events` (24), `parse`, `time`, `tty`, `warn`, `concurrent`, `text-truncation`, `write-source` (the single write seam, AGENTS.md). Reused by every capability, change on their own axis → CRP says shared-at-root.
- **Kernel clusters nested but not sliced:** `core/config/` (82 importers) and `core/asset/` (asset-ref 29, asset-spec 23, frontmatter 18). High fan-in + universal reuse = *nest in place behind a barrel*, never lift into a slice.
- **Engines** — the indexer pipeline (`indexer/`), source providers (`sources/`), registry (`registry/`), storage (`storage/`), the LLM bounded seam (`llm/`), the agent spawn seam (`integrations/`). These are *reused across capabilities* and/or *contract-locked* → layered.

**Why these specific files stay in the kernel/engine despite "belonging" to a capability (cycle-safety overrides cohesion):**
- `core/state-db.ts` stays in core. It imports `type AkmImproveResult` from `commands/improve` (verified `:57`). **Prerequisite micro-PR before the improve move:** relocate `AkmImproveResult` to a shared type home (keep it in `state-db.ts` and have `improve` import it, or add `core/improve-types.ts`) so the cycle is severed type-only. We do **not** adopt Proposal A's move of `state-db` into `storage/` — that is extra churn (7 importers) for a cycle that a type-relocation fixes outright.
- `core/env-secret-ref.ts` stays in core. It imports `indexer/search-source` (verified `:17`). Moving it into `commands/env/` would drag an `env→indexer` edge into the slice. It stays in core; the env slice costs only 2 importer rewrites.
- `core/memory-contradiction-detect.ts` → moves *into* `commands/improve/memory/` (it imports `llm/client` + `feature-gate`, verified `:40-41`). This is `slice→llm`, the legal downward direction. The "memory-* is pure core" assumption was always wrong; the move corrects the misfiling. **But** the *indexer-side* passes (`memory-inference`, `staleness-detect`, `pass-context`) STAY in `indexer/passes/` — they are engine passes with indexer/llm coupling that improve *calls into*; pulling them into the slice would create a feature↔engine cycle. This split (memory *logic* → slice, memory *passes* → engine) is the precise line.
- `core/proposals.ts` + the 2 validators move *together* into `commands/proposal/validators/`. The 3-file intra-cycle stays internal to the slice, where an intra-slice cycle is tolerable. **Never split across merges.**

### architecture.md updates required (FS-mirrors-architecture)

Fold these into the merge that touches each area (doc lags code; code is the live contract):
1. Drop `vault` as a built-in asset type (lines 23/28); add `env`/`secret` (truth: `core/asset-spec.ts:94-97`, "vault removed in 0.9.0").
2. Update `cli.ts` description from "parsing/shaping module" to "composition root (~620 LOC)"; per-family parsing now lives in `commands/*-cli.ts`.
3. Reconcile workflow persistence path: `workflows/workflow-runs.ts` → `workflows/runtime/runs.ts` + `storage/repositories/workflow-runs-repository.ts`.
4. Replace `output/renderers.ts` mention with the `output/{shapes,text}/` registries (#490).
5. Add the new `commands/<slice>/` folders and the `indexer/{walk,db,graph,search,passes,usage}/` phase folders to the boundary table.
6. Treat the table — not v1-spec §7's aspirational layer-named tree — as the target.

---

## 5. Migration Mechanics (zero behaviour change)

**Mechanism, mirroring #490's proven "one concern per merge, tsc is the ref-resolver" gate:**

- **`git mv`** to preserve history (file content, incl. the 4-line MPL header, rides along unchanged).
- **`ts-morph`** `Directory.move`/`SourceFile.move` to rewrite every importer deterministically (the compiler computes the reference graph from `tsconfig.json`; it moves a symbol's exclusive deps with it and leaves shared deps behind to be imported). This is a codemod, not hand-editing.
- **tsconfig `paths` aliases as a transition aid (Phase 0):** akm is a bundled CLI, not a published library, so the "no `paths` in libs" caveat does not bind it (`moduleResolution: "Bundler"` confirmed). Coarse aliases (`@core/*`, `@storage/*`, `@indexer/*`, `@output/*`, `@llm/*`, plus `@improve/*`, `@proposal/*`, `@sources/*`, `@env/*`) pointing at *current* locations make every later intra-slice move invisible to call sites — this is the churn absorber.
- **High-fan-in barrels (forced by the numbers):** `config.ts` (82), `proposals.ts` (13), `asset-ref` (29), `asset-spec` (23), `frontmatter` (18), `indexer/db` (15), `indexer.ts` (11) keep a **same-path re-export shim with explicit named exports (never `export *`)**, one level only, as temporary scaffolding — or rely on the alias target. Prefer alias over shim; retire shims once aliases are universal. `errors` (76) and `common` (57) are **not moved at all** — pure churn, zero cohesion gain.

**Keeping the two invariants green (per merge, mechanically):**
- **MPL headers:** `git mv`/ts-morph preserve bytes, so the header rides along. Add a post-move assertion to the migration script that every relocated file still opens with the 4-line MPL block (it is the MPL *text*, not an SPDX id); `scripts/lint-license-headers.ts` stays green. New files (e.g. `core/improve-types.ts`) get the header added explicitly.
- **Test-isolation linter — THE KEY HAZARD:** the allowlist in `scripts/lint-tests-isolation.ts` uses **PINNED PATHS, not globs** (verified: `"tests/paths.test.ts"`, `"tests/commands/search.test.ts"`, etc.). So whenever a `tests/**` file is renamed/moved in a slice's merge, its allowlist entry **must be updated in the same commit**, or `bun run lint` fails. Build this into the move script: for every moved test file, rewrite its allowlist entry. Move matching `tests/**` files in the SAME merge unit so the parallel tree never drifts. Cite `knowledge:projects/akm/test-harness-redesign` in each test-touching merge.
- **Guard seams:** `llm/` and `integrations/agent/` are UNMOVED, so `tests/architecture/{llm-stateless-seam, agent-spawn-seam, agent-no-llm-sdk-guard}.test.ts` stay green by construction.

**Verifying byte-identical CLI surface + tests after each step:**
1. `bunx tsc --noEmit` — the "fix all refs" net; proves no broken import.
2. `bun run lint` — license-header + test-isolation linters (and the updated allowlist).
3. `bun run test:unit` (<60s) + `bun run test:integration`.
4. CLI-surface guard: diff the `subCommands` keys (the ~39–41 public verbs) and a JSON-envelope snapshot before/after — must be byte-identical. The `defineJsonCommand` envelopes are unchanged because no `*-cli.ts` is renamed or thinned.
5. `bun run check` (= lint && tsc && test:unit && test:integration) is the merge gate, identical to #490. Each merge is independently revertable.

---

## 6. Phased Plan (independently-shippable, gate-green slices)

Each phase is one merge unit, ordered cheapest-and-highest-cohesion first so it interleaves with feature work without giant conflicts. Churn = real hand-touched call sites *after* Phase-0 aliases absorb the rest.

| Phase | Scope | Effort | Churn (real edits) | Notes |
| --- | --- | --- | --- | --- |
| **0** | Add coarse tsconfig `paths` at *current* locations; optional relative→alias codemod | S | 0 (type-level) | Ships alone behind `tsc --noEmit`. **The churn absorber — must land first.** |
| **0.5** | Prereq micro-PR: relocate `AkmImproveResult` to sever the `state-db→improve` type cycle | S | ~7 (state-db importers, type-only) | Snapshot-gate `computeImproveRunMetrics`. |
| **1** | `commands/improve/` (+ `memory/` sub) | M (big LOC, low churn) | ~3 (improve-cli + cross-edges; backing mods 0–1 importers) | **First real move — cheapest, biggest cohesion win.** |
| **2** | `commands/proposal/` (move core 3-cycle as ONE unit into `validators/`) | S | ~0 net (proposals 13 behind barrel) | Never split the cycle. |
| **3** | `commands/env/`, `commands/graph/`, `commands/tasks/`, `commands/agent/` | S | low | env keeps `env-secret-ref` in core. |
| **4** | `commands/read/`, `commands/sources/` | M | moderate | engines stay put. |
| **5** | `indexer/{walk,db,graph,search,passes,usage}/` | M | ~10 (db 15 + indexer 11 behind barrel; sub-clusters ≤2 each) | esbuild/Biome pipeline-phase nesting. |
| **6** | `core/asset/` nest | M | ~70 behind barrels (or ~0 aliased) | asset-ref/spec/frontmatter. |
| **7** | `core/config/` nest | M | ~0 behind barrel/alias (82 sites) | **Riskiest single move** — strictly behind shim; cycle-check after. |
| **8** | `workflows/{authoring,runtime}/`; `output/.../proposal/` cosmetic; architecture.md reconciliation | S | low | Lowest priority. |

**Interleaving with ongoing feature work:** because Phase 0 lands aliases first, any feature branch that imports via `@core/*` etc. is unaffected by later physical moves. Each slice touches a *disjoint* set of files (improve ≠ proposal ≠ sources), so concurrent feature work on one capability only conflicts with the one phase that moves it — schedule that phase when no large feature is mid-flight on that capability. Defer `core/config/` (Phase 7) to a quiet window since it has the widest blast radius. The `tests/**` allowlist edits are localized per phase, so they do not collide across phases.

---

## 7. Risks + Non-Goals

**Risks:**
- **Test-isolation allowlist is pinned-path, not glob (CONFIRMED).** Every test move must update its allowlist entry in the same commit or `bun run lint` fails. Highest-frequency hazard; automated in the move script.
- **Barrel cycles / eager-import startup cost** in the bundled Bun binary. Mitigation: explicit named re-exports only, never `export *`; one level; only at high-fan-in old paths; prefer alias; run a `madge`/`bun` cycle check after the `core/config/` move.
- **Phase 0 dependency.** The whole plan is cheap *only because* aliases land first. If Phase 0 slips, later phases balloon to ~250 hand edits. Phase 0 is the schedule's critical path.
- **`improve/` is the biggest single PR** (~10k LOC + tests) — large review surface despite low churn; reviewers trust the snapshot gate.
- **Exposed cycles if the line is ignored.** If a reviewer lets `memory-inference` into `improve/`, a feature↔engine cycle appears. The §4 rule (passes stay in engine) must be enforced.

**Non-goals (explicit — what NOT to do):**
- **No `src/services/` layer.** Hard #490 rule. Slices are command-family folders, not a service tier.
- **No re-slicing logic, no duplication, no rewrites.** Pure relocation. This is what structurally sidesteps VSA's duplication critique — duplication is forbidden by the behaviour-identical constraint.
- **Do NOT move `errors` (76) or `common` (57)** out of the kernel root — pure churn, zero gain.
- **Do NOT move `state-db` into `storage/`** (rejecting Proposal A's choice) — the type-cycle is fixed by type-relocation, not a 7-importer move.
- **Do NOT relocate the `*-cli.ts` seam out of `commands/`** (rejecting Proposal A's `src/features/`) — keep the #490 seam in place.
- **Do NOT touch `llm/`, `integrations/`, `storage/`, `output/`** — guarded/#490-target layers.
- **Defer `paths.ts` (35) → `storage/locations` consolidation** to a later round; flagged, not done.
- **`setup.ts` (2,826 LOC) and `improve.ts` god-function decomposition are out of scope** — those are #490 WS9 concerns, not reorg concerns.
- **Deep-nesting limit: 2 levels under `src/`, 3 maximum** (e.g. `commands/improve/memory/`, `indexer/db/`). No 5-level trees. **No one-file folders** — thin leaves stay flat.
- **Barrel policy:** barrels are NOT the migration mechanism. One level max, explicit named exports only, only as temporary high-fan-in shims, retired once aliases are universal. No public API / `exports` map (AGENTS.md: CLI-only package).
