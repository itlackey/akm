# D3 — Finalized design: decompose `consolidate.ts` via subtract-first pure moves

**Verdict (one line):** Extract **5 modules** (one types-sink + four cohesive leaves) as byte-identical pure moves behind re-export shims; **SKIP** the journal-cluster extraction, the `clusterMemoriesBySimilarity` extraction, and **both** X2 `callStructured` migrations (the chunk-plan call and the merge leaf) — all three fail the subtract-first / fit tests. Net effect: `akmConsolidateInner` shrinks, four genuinely-independent responsibilities stop sharing a file with the transactional spine, and **no** new abstraction or force-fit is introduced.

A 3-lens design team (subtract-first / domain-modeler / failure-analyst) ran independently on `src/commands/improve/consolidate.ts` (3,442 LOC). This document is the synthesis, re-verified against the code. It follows the R5 precedent (`docs/technical/r5-design.md`): the team is empowered to reject the plan's proposal, and it did — shrinking the plan's 4-file target *and* dropping the X2 fold-in the plan tentatively scheduled.

---

## 1. Findings that shrink the plan (with receipts)

### Receipt A — the plan's "reuse" justification has ZERO current callers
The plan (`architecture-refactor-plan.md:218`) justifies the split with *"Sanitize/chunk-math become reusable (recombine/distill also build prompts + sanitize output)."* Grepping every non-test `.ts` for the would-be-shared functions outside `consolidate.ts`:
```
grep -rE "sanitizeMergedContent|buildChunkPrompt|computeSafeChunkSize|stripOuterCodeFence|normalizeUpdatedField|mergePlans"  (non-test, outside consolidate.ts)
→ (no results)
```
`recombine.ts` builds prompts with `parseFrontmatter`+`assembleContent` core helpers, not `buildChunkPrompt` (which embeds the consolidate JSON-op grammar) nor `sanitizeMergedContent` (consolidate-merge-specific). **The reuse is speculative.** Per subtract-first, D3 is therefore an *internal readability* win on a 1,500-line function, not a cross-module-reuse win — and we do not extract for reuse that does not exist. (If a real second caller lands later, promote `sanitize`/`chunking` to a shared location then.)

### Receipt B — the external import surface is ONE type
Only `core/improve-types.ts:5` imports from consolidate.ts, and only `ConsolidateResult` (a type). No split here deletes *cross-codebase* coupling; coupling reduction is internal (orchestrator cohesion). Re-export shims keep that one external import (and all test imports) byte-stable.

### Receipt C — no module-level mutable state, no import-time side effects, no cycle risk
Only `const`s (`CONSOLIDATE_SYSTEM_PROMPT`, `CHARS_PER_TOKEN`, `PROMPT_OVERHEAD_TOKENS`) and imported constants. Sibling modules (`dedup.ts`, `homeostatic.ts`) do not import `consolidate`. So leaf moves carry no shared-state or circular-import hazard — provided shared **types** move to a sink the leaves can import without back-edging the orchestrator (see §3).

### Receipt D — the X2 fit test FAILS for both LLM calls
```
grep -E "isContextSizeError|provider_html_error|LlmCallError|classifyLlmError|context_limit"  src/commands/improve/consolidate.ts
→ (no results)
```
- **Chunk-plan call (~1916–1989):** wraps a **hand-rolled single-retry with 2s backoff** that `callStructured` (`src/llm/structured-call.ts`) does not model — migrating would silently DROP the retry (lost chunks on transient timeouts). Plus an `AKM_DEBUG_LLM` raw-dump side-channel and per-chunk accounting bumps on the error path. **SKIP.**
- **Merge leaf `generateMergedContent` (~3279–3426):** the `parse` step is a heavy pipeline (`sanitizeMergedContent` → fence-error classification → content-preservation floor → frontmatter-superset repair) living *outside* any gate, and it maps all failures to one `merge_transport_failed` with no classify ladder. This is the exact "try-body wrapping much more than the call / ungated / no classify ladder" profile the plan's own X2 scope finding (`architecture-refactor-plan.md:130`) says to leave alone. Adopting `callStructured` would *add* error classification the caller never branches on = net-positive machinery. **SKIP.**

This confirms the plan's instruction "re-run the fit test, don't assume it fits": it does not fit. D3 is a **pure decomposition with no X2 component.**

---

## 2. The module set (what we DO)

Five new files under `src/commands/improve/consolidate/`. Every symbol is re-exported from `consolidate.ts` so external + test imports are unchanged.

| Module | Symbols moved | Coupling deleted | Coverage today |
|---|---|---|---|
| **`consolidate/types.ts`** (sink) | `MemoryEntry` (440), `ConsolidateMergeOp/DeleteOp/PromoteOp/ContradictOp/Operation` (79–124), `ConsolidateOpKind` (260), `RawChunkPlan` (871) | Breaks the cycle that any leaf extraction would otherwise create (leaves need these types; orchestrator imports leaves) | type-only |
| **`consolidate/sanitize.ts`** | `recoverMalformedFrontmatter` (2869), `stripOuterCodeFence` (2908), `SanitizedMergedContent` (2926), `sanitizeMergedContent` (2933), `normalizeUpdatedField` (3046) | Pure string/frontmatter transforms stop sharing a file with chunk math + the transaction engine. Imports nothing from the consolidate domain. | `consolidate-pipeline-fixes.test.ts` (+ pin `recoverMalformedFrontmatter`) |
| **`consolidate/chunking.ts`** | `CHARS_PER_TOKEN` (522), `PROMPT_OVERHEAD_TOKENS` (531), `DEFAULT_CONTEXT_LENGTH_TOKENS` (550), `computeSafeChunkSize` (568), `buildChunkPrompt` (759) | Token math + prompt assembly become independently testable; **excludes** `clusterMemoriesBySimilarity` (embedder/state-db dep) | `consolidate-chunks.test.ts` + `standards-prompt-injection.test.ts` (well covered) |
| **`consolidate/merge.ts`** | `isValidOp` (876), `mergePlans` (894) | Pure plan-reconciliation algebra over `ConsolidateOperation[]`; no fs/LLM/config | `consolidate-promote-dedup.test.ts` |
| **`consolidate/eligibility.ts`** | `isConsolidationEligibleMemoryName` (448), `isHotCapturedMemory` (471), `ConsolidateGuardVerdict` (494), `consolidateGuardStatus` (496) | "May we touch this memory?" policy leaves the orchestrator | 2 of 3 covered (+ pin `consolidateGuardStatus`) |

`isValidOp` and `consolidateGuardStatus` are the only currently-private symbols whose surface widens — justified: each is a cohesive unit with an already-exported sibling, and both gain a direct pinning test.

---

## 3. What we SKIP (with why) — the subtract-first decisions

- **Journal/backup/archive cluster (~1030–1266)** — NOT a module. All 16 call sites (`writeJournal`, `backupFile`, `archiveMemory`, `markJournalCompleted`, `cleanupJournal`, `getBackupDir`, …) are inside `akmConsolidateInner`, and all are private. It is the **transactional spine** of the destructive Phase-B write loop — the journal *is* the consolidate transaction. Extracting it forces exporting ~8 functions purely to be called back from the same orchestrator: surface widening with **no** coupling deletion (the orchestrator stays exactly as coupled, now across a file boundary). This is the clearest "relocate, don't decouple" trap. Leave it next to the loop that drives it. (Also: it has **zero** characterization tests and touches user backups — extracting it would be the highest-likelihood data-correctness regression in D3 for no coupling win.)
- **`clusterMemoriesBySimilarity` (603)** — keep in orchestrator. It pulls in `embedBatch`/`cosineSimilarity`/`resolveEmbeddingModelId` (llm/embedder) + the state-db body-embedding cache — the heaviest dependency set in the non-orchestrator surface. Moving it into `chunking.ts` would re-create false cohesion (embedder code next to `Math.floor`).
- **`loadMemoriesForSource` / `narrowToIncrementalCandidates` loader cluster** — leave in orchestrator for now. Lower value; only `narrowToIncrementalCandidates` is covered. Revisit only if it falls out cleanly.
- **Both X2 `callStructured` migrations** — see Receipt D. The chunk-plan call would drop its retry; the merge leaf is an ungated force-fit. D3 ships with no X2 component.
- **Orchestrator internals** (`akmConsolidate`, `akmConsolidateInner`, `promptConfirm`, `resolveConsolidateLlmConfig`, `injectGenerationFrontmatter`, all `process.env`/stdout sites) — stay. The orchestrator shrinks as leaves leave; we do not force every helper out.

---

## 4. Import direction (acyclic)

```
consolidate/types.ts        ← (pure sink; imports nothing from the domain)
   ▲      ▲      ▲      ▲
sanitize chunking merge eligibility   (leaves; each imports only types.ts from the domain)
   ▲      ▲      ▲      ▲
        consolidate.ts (orchestrator — imports all leaves; re-exports every moved symbol)
```
The one ordering subtlety (domain-modeler's load-bearing catch): `MemoryEntry` lives at line 440 *inside the body*. It must move to `types.ts` **first**, or every leaf gets a back-edge to the orchestrator → cycle. Hence types.ts is increment 1.

---

## 5. JSON stdout / Node↔Bun parity

`consolidate` is **not** a standalone CLI command (no `parse-args.ts` entry) — `akmConsolidate` returns a `ConsolidateResult` object to its only caller `improve.ts`. The `setup --yes`-to-stdout class of bug does not apply. The only `process.stdout.write` sites are in `promptConfirm` (TTY-gated) and stay in the orchestrator. DB access is already X1-seamed; pure moves alter no DB-open/error-string surface. Parity command is run before the PR regardless; pure-move increments don't change behavior.

---

## 6. Implementation checklist (TDD, smallest proven increments — gate after each)

Each: RED characterization (green on current code where coverage is thin) → move + re-export shim → keep green → adversarial review → commit-or-revert. Gate = `bun run lint` (**count warning lines**, exit code lies) + `bunx tsc --noEmit` (0) + `bun run test:unit` (0) + `bun run test:integration` (0, re-verify by hand if it "hangs" — #664 race).

1. **`consolidate/types.ts`** — move shared types FIRST; re-export from consolidate.ts. tsc-only change (no runtime). Gate.
2. **`consolidate/chunking.ts`** — best-covered cluster; proves the move+shim pattern cheaply. Gate.
3. **`consolidate/sanitize.ts`** — add a direct pin for `recoverMalformedFrontmatter` (currently only indirect), then move. Gate.
4. **`consolidate/eligibility.ts`** — write a pin for `consolidateGuardStatus` (0 tests) first, then move. Gate.
5. **`consolidate/merge.ts`** — `mergePlans`+`isValidOp` (covered). Gate.
6. **Full gate + node-compat parity** before the PR.

**Stop conditions:** if any move adds net lines beyond the re-export shim without deleting real coupling, or a "pure" module ends up needing orchestrator context, that cluster stays put. Steps 1–5 are the high-confidence subtractions; nothing beyond them is in D3 scope.

---

## 7. Net estimate

Five small modules; `akmConsolidateInner` and its journal transaction stay put. Surface widening = exactly 2 previously-private symbols (`isValidOp`, `consolidateGuardStatus`), each gaining a test. **No** journal extraction, **no** clustering extraction, **no** X2 migration, **no** new abstraction. The win is cohesion (string-mangling, token-math, plan-algebra, and eligibility policy no longer share a file with the destructive transaction engine), achieved entirely by behavior-preserving moves.
