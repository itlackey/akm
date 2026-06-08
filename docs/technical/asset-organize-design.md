# Asset Organize — Graph-Driven Subdirectory Organization (Design)

> Status: DESIGN (no code). Issue: itlackey/akm#504 "Organize stash assets into subdirectories".
> Branch surveyed: `release/0.9.0` @ `055ad182`. Read-only investigation.
> Honors `knowledge:coding-constitution` (layered architecture: command → core → indexer/storage; data-safety first) and aligns with the consolidate vision (`knowledge:projects/akm/consolidation-future-vision`).

---

## 1. Problem framing — what this is, and what it is NOT

Issue #504 has two halves:

1. **Create-in-subdir** — SHIPPED via `--path` (#503, commits `80f9d567`, `f16ffefc`). `--path personal` + `--name grocery-list` produces the nested asset name `personal/grocery-list`; the resolver writes it under `<type>/personal/grocery-list.md`. See `src/core/asset/asset-create.ts` (`normalizeCreateSubPath`, `combineCreatePath`).
2. **Organize-existing** — the subject of this doc. Take a flat directory of already-created assets and group RELATED ones into subdirectories automatically.

### The reverted `akm move` (why "not even close")

Commit `3d11ab96` added `akm move <ref> <dest>` (alias `mv`): it moved an asset's file(s) under a new subpath in the same type root and reindexed. It was reverted (not in tree at `055ad182`; `grep` for `akm move`/`src/commands/move.ts` returns nothing). It missed the feature request on three axes:

- **Manual, not automated.** The user must already know the grouping. #504 asks the *system* to discover the grouping.
- **Not graph-driven.** It ignored the entity/relation graph entirely — no alignment with the consolidate "actively search/prune using graph relations" vision.
- **Data-integrity hole (the fatal one).** It moved the file and reindexed, but a move changes the asset's ref (`knowledge:foo` → `knowledge:personal/foo`), and it rewrote **nothing** that pointed at the old ref. Every inbound reference — inline `REF_RE` body refs in other assets, frontmatter edge fields, state.db rows — silently orphaned.

**This design replaces the manual verb with an automated, graph-driven, dry-run-first, transactional organizing pass** whose headline invariant is: *no reference is ever orphaned by a move.*

---

## 2. The graph — what relation signal actually exists

### 2.1 Storage shape (evidence)

Graph is extracted by `runGraphExtractionPass` (`src/indexer/graph/graph-extraction.ts`) over `memory:`/`knowledge:` assets (configurable include-types, `getGraphExtractionIncludeTypes`) and persisted to SQLite (`src/indexer/db/graph-db.ts`, `replaceStoredGraph`). Three tables (`src/indexer/db/db.ts:417-446`):

- `graph_files(entry_id PK, stash_root, file_path, file_type, body_hash, …)` — one row per asset (`UNIQUE(stash_root, file_path)`, FK to `entries.id`).
- `graph_file_entities(entry_id, entity_order, entity_norm, entity)` — entities the LLM surfaced **per asset**.
- `graph_file_relations(entry_id, from_entity_norm, from_entity, to_entity_norm, to_entity, relation_type, confidence)` — relations **between entities**, scoped to the asset they were extracted from.

### 2.2 The critical distinction: entity↔entity, NOT asset↔asset

**Relations are stored entity-to-entity, attached to a single asset's `entry_id`** (`graph-db.ts:160-164`, `graph-extraction.ts:252-263`). There is **no first-class asset→asset edge table.** The graph answers "which entities does asset X mention, and how do those entities relate *within X*" — it does NOT directly answer "asset X relates to asset Y".

### 2.3 But asset-relatedness is already derivable — and already implemented

The asset→asset signal is **shared-entity overlap**, and akm already computes it: `listRelatedPathsForFile` (`src/indexer/graph/graph-boost.ts:364-504`) runs a SQL self-join on `graph_file_entities` (`e.entity_norm = target.entity_norm AND e.entry_id != target.entry_id`), groups by candidate `entry_id`, and orders by shared-entity count desc. It returns, per related asset: `{ ref, path, type, sharedEntities[], relationCount }`. This is **exactly** the clustering primitive #504 needs, already battle-tested and indexed.

Two more signals exist:
- **Entity co-occurrence / hop-reachability** — `readParsedGraphContext` (graph-boost.ts:525) builds an undirected entity adjacency map with edge confidence; `loadGraphBoostContext` does BFS over it. Two assets can be "related" by sharing entities that are 1 hop apart in the relation graph, not just identical entities.
- **Embedding similarity** — `consolidate.ts:496` (`clusterMemoriesBySimilarity`) embeds descriptions+tags and does a greedy nearest-neighbour chain via `cosineSimilarity`/`embedBatch`. Independent of the LLM graph; available whenever `config.embedding` is set.

### 2.4 Available-graph-signal VERDICT

**The signal exists and is genuinely usable, but it is graph-extraction-dependent and quality-gated — it is NOT free, and it is thin on a cold or under-extracted stash.**

- The shared-entity self-join (`listRelatedPathsForFile`) is the strongest, most explainable signal and is **already shipped**. Grouping reduces to "cluster the asset graph whose edges are shared-entity counts."
- BUT the graph only covers `memory`/`knowledge` by default (`DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES`), requires a configured LLM provider, and is explicitly disable-able (three gates: provider, feature-gate, `index.graph.llm`). On a stash with no graph extracted, **there is zero relation signal** and the organizer must no-op (not guess).
- Quality is uneven: `buildLowQualityWarnings` flags coverage < 0.3 and "many entities but no relations." Entities are also noisy (generic-entity filtering exists in `runtimeTelemetry.filteredGenericEntities`). Over-grouping risk is real — two assets sharing one generic entity ("project", "config") are NOT meaningfully related.

**Conclusion:** auto-organize is viable **today** for `knowledge`/`memory` on a stash with extracted graph, using shared-entity overlap (optionally blended with embeddings). It must degrade to "propose nothing" — never a guess — when the graph is absent or below a coverage floor. Treat embeddings as a fallback/secondary signal so the feature still produces *something* explainable when the LLM graph is thin.

---

## 3. Refs, paths, and what a move actually changes

### 3.1 Ref → path mapping

- A ref is `[origin//]type:name` (`src/core/asset/asset-ref.ts`). `name` may contain `/` (subdir nesting) — `validateName` explicitly permits multi-segment names while rejecting absolute/`..`/drive paths.
- `name` → relative path is per-type via `ASSET_SPECS[type].toAssetPath` / `resolveAssetPathFromName` (`src/core/asset/asset-spec.ts`). The registry-derived helper `refToRelPath(type, name)` (`src/commands/lint/base-linter.ts:144`) is the canonical "ref → stash-relative path" function (`<typeDir>/<name>.md`, with skill/task/env/secret variations).
- A subdir move is purely a **name change**: `knowledge:foo` (file `knowledge/foo.md`) → `knowledge:personal/foo` (file `knowledge/personal/foo.md`). Same type root, same origin; only the `name` segment gains a directory prefix. Multi-file assets (skill = `<name>/SKILL.md`) move as a directory unit.

### 3.2 What stays stable, what changes

`entries.entry_key` (`db.ts:250`, `UNIQUE`) is derived from `stash_dir + type + name`. Because the move changes `name`, **`entry_key` changes**, and on reindex the entry is treated as delete-old + insert-new (new `entries.id`). That is the root of the blast radius: anything keyed on `entry_id` survives the reindex *only if* it is re-associated, and anything storing the *ref/name string* must be rewritten.

---

## 4. The ref-update blast radius (the hard part)

Moving one asset changes its ref. Every persisted pointer to the old ref/path/entry_id must be transactionally rewritten or the link orphans. Enumerated persistence sites:

### 4.1 index.db (`src/indexer/db/db.ts`)
| Site | Keyed by | Move impact |
|---|---|---|
| `entries.entry_key` / `file_path` / `dir_path` | ref-derived key + path | **Changes.** New `entry_key`, new `id` on reindex. |
| `entries.derived_from` (`db.ts:257`) | parent ref string | **Rewrite** if any child points at the moved asset's old ref. |
| `embeddings` (`db.ts:302`) | `entry_id` FK | Survives if entry_id preserved; else regenerated on reindex (acceptable but a cost). |
| `utility_scores` (`db.ts:329`) | `entry_id` PK, FK CASCADE | **CASCADE-deletes** if old entry row is deleted → usage history LOST unless migrated to new entry_id. |
| `utility_scores_scoped` (`db.ts:345`) | `(entry_id, scope_key)` | Same loss risk. |
| `graph_files` + `graph_file_entities` + `graph_file_relations` | `entry_id` + `file_path` | `file_path` changes; rows re-keyed on reindex. `replaceStoredGraph` handles path drift but may re-extract. |
| `entries_fts` / `entries_fts_dirty` | derived | Rebuilt on reindex. |

### 4.2 state.db (`src/core/state-db.ts`)
| Table | Ref column | Move impact |
|---|---|---|
| `proposals` (`state-db.ts:222`) | `ref NOT NULL` | **Rewrite** — a pending proposal targeting `memory:foo` must follow to `memory:personal/foo` or it dangles. |
| `events` (`state-db.ts:172`) | `ref` (nullable) | **Rewrite** — history/audit refs point at old ref. |
| `task_history` (`state-db.ts:275`) | `target_ref` | **Rewrite** if target was the moved asset. |
| `improve_runs` (`state-db.ts:391`) | `scope_value` (when `scope_mode = "ref"`) | **Rewrite** for ref-scoped runs. |
| `extract_sessions_seen` (`state-db.ts:460`) | session/path keyed | Re-evaluate; low risk but audit. |

### 4.3 Cross-references inside OTHER assets' content (the reverted-move killer)
- **Inline body refs.** akm DOES have an asset-cross-reference convention: `REF_RE` (`base-linter.ts:126`) matches `type:name` tokens (e.g. `knowledge:foo`, `workflow:bar`) embedded in any asset body, delimited by whitespace/quotes/parens. The `missing-refs` linter (`checkMissingRefs`, `base-linter.ts:211`) already walks these and resolves them via `refToRelPath`. There is **no `[[wikilink]]` syntax** (confirmed: `[[` appears only in unrelated completion/config code) — the inline `type:name` token IS the link. Moving an asset breaks every other asset that mentions its old ref in prose, fenced commands, or frontmatter.
- **Frontmatter edge fields.** Observed ref-bearing frontmatter keys: `derived_from`/`derivedFrom`, `supersededBy`/`superseded_by`, `contradictedBy`, `parent`, `relatedRefs` (grep across `src/core`, `src/commands/improve`). Any of these in *another* asset pointing at the moved ref must be rewritten.

### 4.4 On-disk move + git
- File move uses the existing write primitives: `writeAssetToSource` + `deleteAssetFromSource` (`src/core/write-source.ts`) — there is no atomic rename helper today; a move = write-new + delete-old (or a `fs.rename` added at the core layer).
- **Git batch-commit model (#507).** Per-asset commits were retired (`f...`/`commitWriteTargetBoundary`, write-source.ts:60). Git-backed targets stage `.akm/` + sibling assets together (`git add -A`) and commit **once at the operation boundary** via `commitWriteTargetBoundary` → `saveGitStash`. The organizer must therefore perform ALL file moves + ALL ref rewrites, then fire exactly ONE boundary commit — matching the batch model and giving a single revertable git commit as the outermost safety net.

### 4.5 Blast-radius SUMMARY
**~13 persistence sites across 3 stores plus 2 in-content classes:**
- index.db: 7 (`entry_key`/`file_path`/`dir_path`, `derived_from`, `embeddings`, `utility_scores`, `utility_scores_scoped`, 3 graph tables, fts) 
- state.db: 5 (`proposals.ref`, `events.ref`, `task_history.target_ref`, `improve_runs.scope_value`, `extract_sessions_seen`)
- in-content: 2 classes (inline `REF_RE` body tokens in other assets; frontmatter edge fields `derived_from`/`supersededBy`/`contradictedBy`/`parent`/`relatedRefs`)
- disk/git: 1 (file move + single boundary commit)

The reverted `akm move` addressed exactly ONE of these (the file move + reindex of `entries`). This is why it orphaned links.

---

## 5. Safety model — dry-run-first / proposal-style, transactional

Mirror the consolidate engine's proven safety machinery (`src/commands/improve/consolidate.ts`):

1. **Dry-run first / proposal-style (default).** Like `consolidate --dry-run` and the proposal queue: the organizer's default output is a **plan** (`OrganizeOperation[]`), never a mutation. Each op carries `{ ref, fromName, toName, groupKey, evidence, confidence }`. The plan is rendered for human/agent review and (recommended) lands in the **proposal queue** as an `organize` proposal type so it routes through the existing `akm proposal accept/reject/diff` review surface. Nothing moves without explicit approval (or an `--auto-accept <threshold>` gate identical to consolidate's confidence gate).
2. **All-or-nothing transaction.** Each accepted op is a *bundle*: (move files) + (rewrite all 13 persistence sites) + (rewrite inbound content refs). Apply the whole organize run inside a single journaled transaction. DB writes go through one `db.transaction(...)`; the git side is one boundary commit. Partial application is forbidden.
3. **Journal + backup (reuse consolidate's pattern).** Write `.akm/organize-journal.json` (cf. `getJournalPath`, `writeJournal`, `markJournalCompleted`) listing every op and completion marks; copy each touched file into `.akm/organize-backup/<ts>/` before mutation (`backupFile`). On startup, `checkForIncompleteJournal` aborts (or `--organize-recovery clean`) if a prior run was interrupted.
4. **Mid-failure behavior.** If any op fails mid-apply: stop, leave the journal in place, do NOT commit git. Recovery = restore from backup dir + roll back the DB transaction (or, since DB writes are one transaction, the rollback is automatic and only the filesystem needs backup-restore). The single git boundary commit means an un-committed working tree is trivially `git checkout`-able as a last resort.
5. **Idempotency.** An op whose target path already exists, or whose source already lives at the destination, is a no-op (the reverted move already refused existing-destination; keep that guard). Re-running the organizer on an already-organized stash produces an empty plan. Ref-rewrite is idempotent: rewriting `memory:foo`→`memory:personal/foo` a second time finds no `memory:foo` tokens.
6. **Never-lose-an-asset guards (port from consolidate).** Refuse on read-only/registry sources, type-root change, path traversal/absolute/drive-letter destinations (`isWithin`), and hot/user-explicit assets. Archive-not-destroy is irrelevant here (organize never deletes content) but the same posture applies: a move that cannot rewrite ALL inbound refs must FAIL the op, not proceed and orphan.

---

## 6. Grouping heuristics (ranked, with tradeoffs)

All three must produce an **explainable** result: every grouping decision records *why* (which shared entities / which similarity / which group label).

### Option A (RECOMMENDED) — Shared-entity connected components, label by dominant entity
Build an asset graph where nodes = assets of the target type and edges = shared-entity count from `listRelatedPathsForFile` (already implemented). Drop edges below a `minSharedEntities` threshold (default 2 — one shared generic entity is noise) and below a `minSharedConfidence`. Find connected components (or louvain-style communities for larger stashes). Each component with ≥ `minClusterSize` assets becomes a subdirectory; the subdir name is the **dominant shared entity** across the component (slugified), which is inherently explainable ("grouped because all share entity `kubernetes`").
- **Stability:** high — components are deterministic given a fixed graph; small graph perturbations rarely flip membership when the threshold is ≥ 2.
- **Explainability:** highest — "moved to `kubernetes/` because it shares entities {kubernetes, helm} with 4 others."
- **Over-grouping risk:** controlled by the shared-entity threshold + generic-entity filtering. The main failure mode is a hub entity merging everything; mitigate with a max-component-size cap that splits oversized components by secondary entity.
- **Cost:** cheap — pure SQL self-joins, no LLM call at organize time (the LLM cost was already paid at index/graph-extract time).

### Option B — Embedding-cluster (k-NN chain / threshold clustering)
Reuse `clusterMemoriesBySimilarity` (`consolidate.ts:496`): embed asset description+tags, cluster by cosine similarity. Subdir label = LLM-summarized or centroid-nearest entity.
- **Stability:** medium — sensitive to embedding model + threshold; re-embedding after edits can reshuffle.
- **Explainability:** lower — "these are 0.82 cosine-similar" is less legible than shared named entities; needs an LLM to name the cluster.
- **Over-grouping risk:** medium — semantic drift can pull loosely-related assets together.
- **Use as:** the **fallback** when the LLM graph is absent/thin (Option A produced nothing), since embeddings don't require graph extraction — only `config.embedding`.

### Option C — Relation-hop community (entity adjacency BFS)
Use the entity adjacency map + BFS from `graph-boost.ts` (`readParsedGraphContext`/`loadGraphBoostContext`): assets are related if their entities are within N hops in the relation graph, not just identical. Cluster on that richer connectivity.
- **Stability:** lower — hop-reachability is sensitive to a few high-degree entities; one noisy relation can bridge unrelated clusters.
- **Explainability:** medium — "related via entity path A→B→C" is explainable but harder to summarize as a directory name.
- **Over-grouping risk:** highest — transitive bridging is the classic community-detection over-merge trap.
- **Use as:** an opt-in refinement (`--strategy hop`) for power users, not the default.

### Recommendation
**Default = Option A (shared-entity components, threshold ≥ 2, dominant-entity label), with Option B as automatic fallback when the graph yields no components.** A is explainable, deterministic, already-implemented at the query layer, and LLM-free at organize time. Blend in Option B's embedding similarity only as a tie-breaker/fallback. Gate C behind an explicit flag.

---

## 7. Where it runs + config

**OWNER DIRECTIVE (2026-06-08): organize is a new `improve` PROCESS, not a standalone command.** It is delivered as `processes.organize` — a sibling to `extract`/`reflect`/`distill`/`consolidate` — and emits PROPOSALS rather than moving files directly. This is the primary (and recommended) framing; the standalone command below is demoted to an optional manual trigger.

- **Primary vehicle = `processes.organize` improve process.** Runs inside the improve pipeline like its siblings, gated by `processes.organize.enabled` (default **false**) in the improve profile (`src/commands/improve/improve-profiles.ts` + the profile JSONs in `src/assets/profiles/`). Cadence: a *settled-data* pass — run it on the nightly/consolidate cadence (after `consolidate`), NOT the `frequent` profile. Consolidate merges/prunes content; organize then groups what survives by placement. Config type lands in `ImproveProcessConfig` (`src/core/config/config-types.ts` + `config-schema.ts`), mirroring the `minPoolSize`/`minNewSessions` keys already there (`minClusterSize`, `minSharedEntities`, `strategy`, `autoAcceptConfidence`).
- **Proposal-emitting by construction (this IS the safety model).** The process does NOT move files. It generates an `OrganizeOperation[]` plan and routes each op through the EXISTING proposal queue as a new `organize` proposal kind — reviewed/triaged (human via `akm proposal accept/reject/diff`, or agent via the auto-accept confidence gate) exactly like `consolidate`'s output. The transactional ref-rewrite (§4) runs only on **accept**. So the dry-run/approval requirement is inherited from the proposal flow — no separate `--dry-run` ceremony needed. Apply uses the Phase-0 engine under the journal/backup transaction + one #507 boundary commit.
- **Fail-open / no-op-not-guess.** Same precondition gates as `graphExtraction`: requires an extracted graph (Option A) or `config.embedding` (Option B fallback). When neither is available the process emits an empty plan + a `processes.organize` skip event (mirroring the `consolidation_skipped`/`extract_skipped` pattern from #553/#554) — never a guess. Honors the existing `tryLlmFeature`/provider gates.
- **Optional manual trigger (secondary).** A thin `akm organize [--strategy …] [--min-shared 2] [--min-cluster 3]` command may wrap the same pass for a one-off run that emits proposals (useful for post-import/catch-up), but it is NOT the primary surface and adds no new apply path — it produces the same proposals the improve process does. Ship it only if there's demand; the improve process + proposal queue is the complete loop.
- **Vision alignment.** The owner's recorded vision (`knowledge:projects/akm/consolidation-future-vision`) is that consolidation should *actively* search and prune using graph relations. Organize is the structural complement to consolidate's semantic pruning — same graph signal, same proposal/journal/backup machinery — applied to *placement* rather than *content*, as a sibling improve process. (The vision asset lives in the user's stash, not this repo, so it is not quoted verbatim; this design slots into that machinery.)

---

## 8. Phased implementation plan (each phase independently shippable + gated)

**Phase 0 — Ref-rewrite engine (foundation, no user-facing organize yet).** Build and unit-test the transactional `rewriteRefAcrossStash(oldRef, newRef)` that touches all 13 persistence sites + inline `REF_RE` body tokens + frontmatter edge fields, inside one DB transaction + one git boundary commit, with journal + backup. Ship as internal API. *Gated: not wired to any command.* This is the piece the reverted move lacked; everything else depends on it.

**Phase 1 — Plan generation (read-only, internal).** Implement Option A clustering over `listRelatedPathsForFile` → an `OrganizeOperation[]` plan with evidence + confidence. Pure/internal, zero mutation, unit-tested in isolation. *Gated: not user-facing yet.*

**Phase 2 — `organize` proposal kind.** Emit each plan op as a proposal routed through the existing proposal queue (`akm proposal accept/reject/diff/list`), carrying the move + its evidence (shared entities, target subdir, confidence). Accepting a proposal triggers the Phase-0 ref-rewrite engine (file move + all-13-sites + inbound-ref rewrite, transactional, journal+backup, one #507 boundary commit). *Gated: proposals are inert until accepted; this is the dry-run/review safety surface.*

**Phase 3 — `processes.organize` improve process (PRIMARY delivery).** Wire the Phase-1 plan generator as a new improve process that runs on the settled-data cadence (after `consolidate`) and emits the Phase-2 proposals. Add `processes.organize` to `ImproveProcessConfig` + the profile JSONs; emit a `processes.organize` skip event when the graph/embeddings are unavailable (no-op-not-guess). *Gated: `processes.organize.enabled: false` default.* This is the spine — the improve loop generates proposals, the proposal queue gates the moves.

**Phase 4 — Embedding fallback (Option B) + auto-accept gate.** Embedding-cluster fallback when the graph yields nothing; a consolidate-style `autoAcceptConfidence` gate so high-confidence groupings can apply without manual review. *Gated: requires `config.embedding`; auto-accept off by default.*

**Phase 5 — (optional) `akm organize` manual trigger.** A thin command that runs the same pass once and emits the same proposals (for post-import/catch-up). No new apply path. *Ship only if demand exists; the improve process + queue is already the complete loop.*

**Phase 6 — Strategy expansion (Option C hop-community) + multi-type.** Opt-in `strategy: hop`; extend beyond knowledge/memory to other graph-eligible types. *Gated: explicit config.*

---

## 9. Open decisions needing owner sign-off

1. **entry_id continuity vs. accept-loss.** On a name change, do we (a) preserve `entries.id` by migrating `utility_scores`/`utility_scores_scoped`/`embeddings` to the new entry_key before reindex, or (b) accept that usage history + embeddings regenerate? (a) is correct-but-complex; (b) is simpler but silently drops ranking history. **Recommend (a)** but needs sign-off on the migration cost.
2. **Inline body-ref rewrite scope.** `REF_RE` matches refs in prose AND fenced code/commands. Do we rewrite refs inside fenced code blocks (could break documented command examples that intentionally reference the old path) or only outside them? **Recommend: rewrite everywhere but record each rewrite in the journal for review.**
3. **Frontmatter edge-field canonicalization.** `derived_from` vs `derivedFrom`, `supersededBy` vs `superseded_by` both appear. Confirm the authoritative set of ref-bearing frontmatter keys to rewrite (and whether to normalize casing while we're in there).
4. **Subdir-name source.** Dominant-entity slug (explainable, but can be ugly/unstable) vs. an LLM-named cluster label (prettier, but adds an LLM call + nondeterminism at organize time). **Recommend: dominant-entity slug for v1; LLM naming as an opt-in.**
5. **Threshold defaults.** `minSharedEntities = 2`, `minClusterSize = 3`, max-component-size cap — confirm or tune against the owner's real stash.
6. **Graph-absent behavior.** Confirm the no-op-not-guess posture: when no graph is extracted and no embeddings configured, organize prints "no relation signal available; run `akm index` with graph extraction enabled" and exits 0 with an empty plan. (Recommended.)
7. **Reversibility UX.** Is the single git boundary commit + `.akm/organize-backup/<ts>/` sufficient, or do we want an `akm organize --undo <run-id>` that replays the journal in reverse?

---

### Appendix — key citations
- Graph storage / entity↔entity relations: `src/indexer/db/graph-db.ts:100-282`, `src/indexer/graph/graph-extraction.ts:252-263`, schema `src/indexer/db/db.ts:417-446`.
- Asset-relatedness self-join (clustering primitive): `src/indexer/graph/graph-boost.ts:364-504`.
- Entity adjacency / hop BFS: `src/indexer/graph/graph-boost.ts:184-268,525-589`.
- Embedding clustering: `src/commands/improve/consolidate.ts:496-542`.
- Ref/path mapping: `src/core/asset/asset-ref.ts`, `src/core/asset/asset-spec.ts`, `refToRelPath` `src/commands/lint/base-linter.ts:144`.
- `--path` subdir create: `src/core/asset/asset-create.ts`.
- Inline cross-ref convention `REF_RE` + missing-refs linter: `src/commands/lint/base-linter.ts:126,211`.
- state.db ref columns: `src/core/state-db.ts:172,222,275,391,460`.
- Consolidate safety machinery (journal/backup/dry-run/recovery): `src/commands/improve/consolidate.ts:823-958,1048-1130`.
- Git batch boundary commit (#507): `src/core/write-source.ts:60-99` (`commitWriteTargetBoundary`).
- Reverted manual move: commit `3d11ab96` (`src/commands/move.ts`, not in tree at `055ad182`).
</content>
</invoke>
