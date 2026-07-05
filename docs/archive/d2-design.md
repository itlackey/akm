> **ARCHIVED 2026-07-05 (meta-review 14).** Shipped: `state-db.ts` reduced to a thin facade over the `src/core/state/` split. Retained as a design-decision record.
> Current truth = the code under `src/core/state/`. Git history is the recovery path.

# D2 — Finalized design: decompose `state-db.ts` via verbatim per-table repo moves + ONE migration literal

**Verdict (one line):** Move the 9 per-table CRUD clusters verbatim into `src/core/state/<domain>-repo.ts` behind a re-export shim, move the `MIGRATIONS` array **verbatim as a single ordered literal** into `core/state/migrations.ts` (NO per-repo fragments), relocate the misplaced `REGISTRY_INDEX_CACHE_DDL` to the indexer, and keep the X1 seam in place. **No fragment registry, no salience repo, and the `Proposal` core→commands fix is DEFERRED.**

A 3-lens design team (migration-safety / domain-modeler / subtract-first) ran independently on `src/core/state-db.ts` (2,452 LOC, 47 importers). This is the synthesis, re-verified against the code. As with R5/D3, the team SHRANK the plan's scope after verification.

---

## 1. Honest benefit statement (read first)

The plan claims consumers "stop transitively loading 10 irrelevant tables." **This is false** — in TS/Bun, importing one symbol evaluates the whole module; the tables are DDL strings that only execute under `runMigrations`. The X1 seam already deleted the open/lifecycle coupling, and the shared migration runner (`storage/engines/sqlite-migrations.ts`) already exists. **D2's real and only benefit is file cohesion** — splitting a 2,452-LOC file fusing 9 unrelated table domains into ~9 cohesive files where each table's Row + mappers + CRUD live together. That is a legitimate readability win, but D2 is the **weakest D-item on the "does it delete coupling" test**. It is therefore scoped as cheap **verbatim moves with zero new abstraction**. The moment it grows fragments / a DDL migration rewrite / a type relocation / 47 import rewrites, it has become machinery and must stop.

Net LOC ≈ flat-to-slightly-positive (file headers + the shim). That is expected and acceptable for a cohesion refactor.

---

## 2. The decisive receipt: REJECT per-repo migration fragments

The plan (architecture-refactor-plan.md:205) wants each repo to export its own `Migration[]` fragment, concatenated by a registry. **Disqualified by migration `001-initial-schema`** (`state-db.ts:153–321`): a single `up` string that `CREATE TABLE`s **three tables in one transaction** — `events` (~182), `proposals` (~234), `task_history` (~287). Under fragments, `001` has no single owning repo:
- Splitting it into `001a/001b/001c` **renumbers the permanent `schema_migrations` PK** → on every deployed DB `001-initial-schema` is already applied but the new IDs are not, so the runner re-applies them; the ledger permanently disagrees with prod, and the characterization snapshot (`tests/storage/sqlite-migrations.characterization.test.ts:68-84`) hard-asserts the exact ID list. **Corruption.**
- Parking all of `001` in one repo means that repo's fragment creates three tables → coupling relabeled, not removed.

Migrations `002/006/011/013/015` similarly ALTER or rebuild tables created earlier — the history is an **append-only timeline, not a per-domain partition**.

→ **Move `MIGRATIONS` verbatim as ONE ordered literal** into `src/core/state/migrations.ts`, still fed to `runSqliteMigrations`. Append-only preserved *by construction* (the array is never split). New migrations append to this one literal — and a future cross-table backfill always has a home (the (B) scheme had none). **Precedent:** the salience domain already uses exactly this shape — DDL in the central migration list (009/010/011/015), CRUD co-located with its consumer in `salience.ts` (`salience.ts:356-357` comments it explicitly).

---

## 3. The repository set (9 repos — verbatim moves)

Each → `src/core/state/<name>-repo.ts`. Every symbol re-exported from `state-db.ts` (the barrel) so all 47 importers stay untouched. Row types stay with their repo (1:1 with tables — no shared types-sink needed, unlike D3).

| Repo | Table(s) | Symbols (file:line) | Primary consumer | Test oracle |
|---|---|---|---|---|
| `events-repo` | events | EventRow(884), eventRowToEnvelope(896), insertEvent(1035), ReadStateEventsOptions(1062), readStateEvents(1080), purgeOldEvents(1122), importEventsJsonl(1546) | core/events.ts | state-db-events-purge.test.ts |
| `proposals-repo` | proposals **+ proposal_fs_imports** (satellite) | ProposalRow(926), proposalRowToProposal(942), proposalToRowValues(985), upsertProposal(1139), listStateProposals(1175), listProposalGateDecisions(1216), getStateProposal(1268), listStateProposalIdsByPrefix(1284), hasImportedFsProposals(1300), recordFsProposalsImport(1311), insertProposalIfAbsent(1322) | commands/proposal/validators/proposals.ts | proposal-storage-sqlite.test.ts |
| `task-history-repo` | task_history (+ intervals projection) | TaskHistoryRow(1012), upsertTaskHistory(1376), getTaskHistory(1403), getTaskHistoryRuns(1416), queryTaskHistory(1429), TaskIntervalRow(1468), queryCompletedTaskIntervals(1488) | tasks/runner.ts, health.ts | (via tasks/health tests) |
| `improve-runs-repo` | improve_runs **+ improve_gate_thresholds** (both improve-cycle state) | ImproveRunRow(1619), ImproveRunMetrics(1643), computeImproveRunMetrics(1665), recordImproveRun(1719), ImproveRunSummaryRow(1765), queryImproveRuns(1789), purgeOldImproveRuns(1804), getPhaseThreshold(1246), persistPhaseThreshold(1257) | improve-result-file.ts, improve-auto-accept.ts, health.ts | state-db/improve-runs.test.ts |
| `extract-sessions-repo` | extract_sessions_seen | ExtractedSessionRow(1818), upsertExtractedSession(1852), getExtractedSession(1898), getExtractedSessionsMap(1912), getLastExtractRunAt(1943), shouldSkipAlreadyExtractedSession(1966) | commands/improve/extract.ts | extract-session-tracking.test.ts |
| `consolidation-judged-repo` | consolidation_judged | ConsolidationJudgedRow(1982), getConsolidationJudgedMap(1999), upsertConsolidationJudged(2023) | consolidate.ts | (via consolidate tests) |
| `recombine-hypotheses-repo` | recombine_hypotheses | RecombineHypothesisRow(2046), recordRecombineInduction(2073), findMatchingRecombineHypothesis(2115), getRecombineHypothesis(2152), markRecombineHypothesisPromoted(2164), PresentCluster(2177), decayUnseenRecombineHypotheses(2237) + private helpers | recombine.ts | state-db/recombine-hypotheses.test.ts |
| `body-embeddings-repo` | body_embeddings | BodyEmbeddingRow(2323), embeddingToBlob(2334), blobToEmbedding(2343), getBodyEmbeddings(2358), upsertBodyEmbeddings(2393) | consolidate.ts, dedup.ts | state-db/body-embeddings.test.ts |

> `improve_gate_thresholds` is folded into `improve-runs-repo` (both are improve-run-cycle persisted state; folding avoids a 2-function file — the one concession to subtract-first; consumers import via the barrel so placement is invisible to them). All other repos are one-per-table for a uniform model.

### Infra / barrel — stays in `state-db.ts` (the X1 seam MUST remain importable here)
`getStateDbPath`(78), `openStateDatabase`(110), `withStateDb`(121), `withStateDbAsync`(130), `runMigrations`(867 → imports the migrations literal), `withImmediateTransaction`(1355), `listExistingTableNames`(1508), `export type { Database }`(68). Plus `export * from "./state/<repo>"` for every repo. **No DB-open/error-string surface changes → Node↔Bun parity unaffected.**

### Import direction (acyclic)
Repos import only `storage/database` (`Database`) + (improve-runs) `core/improve-types`. Repos do **not** import the `state-db.ts` barrel (would cycle); consumers call `withStateDb(db => repo.fn(db))`. Barrel imports repos + migrations literal. Watch the `events-repo` ↔ `core/events.ts` edge via `EventEnvelope` — it is `import type` today (no runtime cycle); keep it type-only.

---

## 4. What we SKIP / DEFER (subtract-first)

- **Per-repo migration fragments — REJECTED** (§2). One verbatim literal.
- **Salience repo — DOES NOT EXIST to extract.** asset_salience/asset_outcome CRUD lives in `commands/improve/{salience,outcome-loop,homeostatic}.ts`. D2 only carries their migration DDL (009/010/011/015) into the one literal. (Consolidating that scattered raw SQL into a real salience repo is a separate follow-up relevant to X4 — NOT D2.)
- **`Proposal` core→commands fix — DEFERRED.** `state-db.ts:55` `import type { Proposal }` is a *type-only* circular import (proposals.ts imports runtime values back). It is sound today (type-erased, no runtime cycle). Fixing it properly is a wide-surface semantic decision (relocating `Proposal` + 7 sub-types, or moving the two mappers and changing CRUD signatures) — not a mechanical move. Keep it as-is so the proposals extraction stays purely behavior-preserving. Documented as a follow-up.
- **Rewriting the 47 importers — OUT of scope.** The re-export barrel keeps them untouched; repointing them buys nothing at runtime (§1).

### In scope (small, isolated)
- **Relocate `REGISTRY_INDEX_CACHE_DDL`** (state-db.ts:2441) → `src/indexer/db/db.ts` (its table is an **index.db** table; consumed only at `indexer/db/db.ts:11`). Pure const-string relocation, no ledger touched, deletes a cross-subsystem import. Done as its own isolated increment.

---

## 5. Implementation checklist (TDD, smallest proven increments — gate after each)

Gate = `bun run lint` (count warnings) + `bunx tsc --noEmit` 0 + `bun run test:unit` 0 + `bun run test:integration` 0 (re-verify by hand on idle cores — #664 race). Each step is a behavior-preserving move + barrel re-export.

0. **Add the upgrade-fixture RED test** — seed a DB with only `001`'s tables + `schema_migrations=["001-initial-schema"]`, run migrations, assert `002…015` apply and `001` is NOT re-run (rows preserved). Pins the "no re-application on upgrade" contract the verbatim move must keep. (The fresh-DB id-list + DDL snapshot already exists at `sqlite-migrations.characterization.test.ts`.)
1. **Relocate `REGISTRY_INDEX_CACHE_DDL`** to indexer/db — warm-up, lowest risk, removes a cross-subsystem import.
2. **Move `MIGRATIONS` verbatim** → `core/state/migrations.ts`; `state-db.ts` imports it. Gate on the existing characterization snapshot (riskiest ordering step — do it alone, early).
3. **Extract leaf repos** (smallest surface / single consumer first): consolidation-judged → extract-sessions → body-embeddings → recombine-hypotheses → improve-runs(+gate-thresholds) → task-history.
4. **events-repo** (mind the `core/events.ts` type edge).
5. **proposals-repo LAST** (largest surface; keep `import type { Proposal }` as-is — Proposal fix deferred).
6. **Full gate + node-compat parity** before the PR.

**Stop conditions:** if any move requires changing a CRUD signature, splitting a migration, or rewriting importers, it is no longer a verbatim move — stop and reassess. Steps 1–5 are pure moves.
