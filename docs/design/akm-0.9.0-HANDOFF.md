# akm 0.9.0 Refactor — Handoff Prompt for the Next Agent

You are picking up a large, partially-started refactor of **akm** (a TypeScript/Bun CLI, ~135K src LOC). A previous agent produced a complete, high-quality **design** but then wasted days trying to execute it through elaborate multi-agent orchestration and delivered very little working code. Your job is to **execute the remaining work directly and simply**. Read this whole document first, then read the authoritative plan.

---

## 1. The one rule that matters

**`docs/design/akm-0.9.0-bundle-adapter-architecture-plan.md` is THE authority.** It is a detailed, already-reviewed implementation plan. Do not re-derive it, do not re-plan it, do not build tooling to "ground" it. Read the section for the chunk you're working on and implement it. Where the plan says "preserve behavior," the current code is the oracle; everywhere else, the plan wins.

The maintainer values: honesty over confidence, small correct steps over grand machinery, proof (data) over assertion, and doing exactly what was asked. They have very limited patience for wasted time and tokens — earned by the previous agent's failures. Set honest scale expectations and check scope before destructive or large actions.

---

## 2. Current state (verified 2026-07-15)

Work branch: **`claude/akm-architecture-refactor-fubvd7`** (base all work here, merge here; it descends from `main`).

**Done and merged:**
- All design docs (see §6).
- **Chunk 0a** (hygiene goldens) — merged. ⚠️ The golden oracle set was deleted by a test-suite cleanup (commit `3927ff9`) and **fully restored on 2026-07-16** (gate hardening): 49 designated assets + 13 suites, re-validated green at the chunk-7 HEAD. Presence + frozen-byte integrity are now enforced mechanically by `scripts/lint-goldens-presence.ts` in `bun run lint` — do NOT delete goldens again; retiring/re-baselining an asset goes through `DESIGNATIONS.json` (surface-owner rule in its `$policy`). Five journal-engine-shape fixtures are designated `re-baseline @ Chunk 6` (the engine they pin is replaced there); the outcome-level txn goldens stay frozen through Chunk 6.
- **Chunk 7 (partial):** `WI-7.1` delete recombine/synthesis subsystem (commit `018558f`), `WI-7.2` delete dead improve lanes (`7fe0554`). `WI-7.3` (delete opt-in/default-off branches) is committed as **unreviewed WIP** (`0386d09`) — verify it compiles and behaves correctly, it was never reviewed.
- **Test-suite health (not a plan chunk, but done):** unit vs integration tests are now separated — 259 I/O tests moved to `tests/integration/`; `test:unit` runs 159 true unit files in **~15s** (was ~10 min); `test:integration` runs the rest. 130 junk test files (goldens, coverage-filler, tests-for-deleted-code) were removed. Keep this invariant: **no unit test may touch fs/db/network/subprocess** — those go in `tests/integration/`.

**NOT done (your work):**
- **Chunk 7 remainder:** `WI-7.4`–`WI-7.8` — the actual improve god-function decompositions (`revise`/`learn`/`reflect`/`distill`/`processSession`/`consolidate` into named passes on a `RunContext`). This is the substantive value of Chunk 7 and it was never built. Brief with the work-item breakdown: `docs/design/execution/chunk-7/brief.md`.
- **Chunk 6** — Proposal → `FileChange[]` + one FS transaction.
- **Chunk 9** — cross-cutting sweep (RunContext threading, config schemas, cli dedup, import-cycle ratchet).
- **Wave 2 (all of it):** Chunks `0b, 1, 1.5, 2, 3, 4, 5, 6.5, 8, 10` — the identity migration (asset-type taxonomy → bundle adapters; `type:name` → `[bundle//]conceptId` refs; three-DB cutover). This is the bulk of the release and none of it is started.

⚠️ **Scope check before you touch it:** the maintainer stated that the **recombine deletion (WI-7.1) was meant to be low-priority and possibly out of scope**. Confirm with them which of the §13.1/§14 "residual" fold-ins are actually in-scope before relying on them being done or doing more of them.

---

## 3. How to do the work (execution model)

**Do it directly. You are the developer.** For each chunk:

1. Read the chunk's paragraph in plan **§11**, and the sections its manifest entry cites (`docs/design/akm-0.9.0-chunk-manifest.json` has per-chunk `scope`, `gates`, `deletions`, `testBucket`, `planRefs`).
2. Re-measure any file:line anchors in the plan at current HEAD — they drift.
3. Work test-first where the plan calls for new behavior; for deletions, land the replacement contract test in the same commit; for pure refactors, keep the characterization tests green.
4. Verify with **scoped** commands, not the whole suite: `bun test <specific files>`, `bunx tsc --noEmit`, `bunx biome check <changed files>`. Run the full `bun run check` **once** at the end of a chunk, not per file.
5. Commit in small logical units with scoped messages (`refactor(chunk-N):`, `test(chunk-N):`, `docs(chunk-N):`). **Push after every meaningful commit** — the container recycles and unpushed work is lost.
6. Respect the plan's hard rules (§1.3): **no new trust/approval/security machinery; memory lifecycle stays deferred; deletions gated by zero-count greps not LOC targets; net-LOC is reported not gated.**

**The chunk order** (plan §11, two waves): Wave 1 = `0a✓ → 7(finish) → 6 → 9`. Wave 2 = `0b → 1 → 1.5 → 2 → 3 → 4 → 5 → 6.5 → 8 → 10`. They are sequential and in-branch — later chunks assume earlier ones landed.

**Honest scale:** this is genuinely multi-day work. Each Wave-2 chunk is hours. Tell the maintainer that up front; do not imply it's quick.

---

## 4. Lessons learned / anti-patterns (from the previous agent's failures — do NOT repeat)

- **Do NOT build multi-agent orchestration to run this.** The previous agent built a "wave runner" that spawned grounding fan-outs, adversarial verification panels, and escalation ladders (`.claude/workflows/akm-090-*.js`). It burned days, exhausted the account's **Fable 5 monthly spend cap**, survived two container recycles that lost work, and produced almost no reviewed code. The plan is already the design; a workflow to "align teams with the plan" is pure overhead. **Just write the code.** (You may ignore the `.js` runners and `akm-0.9.0-execution-workflow.md` when working directly, but do NOT delete them: as of 2026-07-16 they carry the no-vacuous-pass gate rules and the execution-workflow doc records the pre-armed ratchets — they remain the option for workflow-run chunks.)
- **Do NOT re-run the full test suite repeatedly.** It was ~10 min per run and the previous agent ran it dozens of times. Use scoped `bun test <paths>`; the full suite runs once per chunk at the gate. (After the unit/integration split, `test:unit` is ~15s — use it.)
- **Do NOT mass-delete files by an unverified heuristic.** The permission system correctly blocks bulk `git rm` of files selected by a fuzzy "value" regex — especially when a read-pass contradicts the regex. Delete only by **specific named directories/files** with objective justification (e.g., "tests for deleted code," "golden fixtures directory"). If you can't prove a test is junk, leave it.
- **Prove claims with data before asserting them.** The previous agent repeatedly declared tests "low value" / the suite "inherently slow" without measuring. The real diagnosis (two-thirds of "unit" tests did I/O; coverage was actually 88%) only appeared after actually counting and running coverage. Measure first.
- **Set scale expectations honestly and up front.** Implying a multi-day refactor would "churn out" quickly caused most of the friction.
- **Push early and often; the environment recycles.** Two recycles vaporized committed-but-unpushed work.
- **Don't lean on Fable 5 for high-volume automated work** — it hit a monthly spend limit mid-run. Opus/Sonnet were fine.
- **When the maintainer says stop / that's not what I meant — stop immediately and re-scope.** Repeatedly acting past that was the single biggest source of harm.

---

## 5. Definition of done (from plan §12.2, abbreviated)

Zero-count greps pass at their chunks (`TYPE_DIRS`, `AkmAssetType`, `parseAssetRef`, `wikiName`, `StashEntry`, `.stash.json`, `getAssetTypes`, `ASSET_SPECS`, `LINTER_MAP` → 0 in `src/`+`scripts/`+`src/assets/`, excluding `src/migrate/legacy/`); 4→3 DBs with a journaled fail-closed cutover; every format handled by one adapter; `Proposal` carries `FileChange[]`; improve = three verbs over passes; import-cycle count 0; docs/schemas migrated. See §12.2 for the full 12-point list.

---

## 6. File reference (where the implementation details live)

| File | What it is / when to read it |
|---|---|
| `docs/design/akm-0.9.0-bundle-adapter-architecture-plan.md` | **THE plan.** §11 = chunk-by-chunk execution order + scope; §2 target architecture; §3 identity migration + cutover; §4 delete/move inventory; §5 improve decomposition map; §6 memory (deferred); §7 index/search; §8 three-DB model; §12 DoD/ledger/contract-tests/risks; §15 test strategy; §16 repo sweep. |
| `docs/design/akm-0.9.0-chunk-manifest.json` | Machine-readable per-chunk scope/gates/deletions/testBucket/planRefs. Your work-list index. Derived from §11 — plan wins on conflict. |
| `docs/design/akm-0.9.0-bundle-adapter-spec.md` | Normative adapter contract (`recognize`/`index`/`validate`/`looksLikeRoot`), `IndexDocument`, diff-persistence, presentation tables. Read before Chunks 1–5. |
| `docs/design/akm-format-neutral-bundle-workspace-spec.md` | Normative workspace/bundle spec (v0.3): config migration (§10.2), CLI convergence (§29), release staging. Read before Chunks 8/10. |
| `docs/design/akm-architecture-decision-history.md` | Decision register D1–D30 — the *why* behind contested choices (e.g., D30: demand-driven machinery only; no trust/lifecycle machinery). |
| `docs/design/akm-0.9.0-plan-vs-spec-deviation-analysis.md` | Reconciled deviations (§4.3a Tier-A bindings, §4.3b memory deferred, §4.3c trust dropped). |
| `docs/design/execution/chunk-7/brief.md` | The prior agent's work-item breakdown for Chunk 7 (WI-7.1–7.8). Useful for the remaining 7.4–7.8, but it was authored by the discredited workflow — sanity-check against the plan. |
| `docs/design/execution/chunk-0a/`, `.../chunk-7/` | Chunk reports + deletion ledgers already produced. |
| `docs/design/akm-0.9.0-residual-complexity-audit.md`, `-greenfield-vs-refactor-decision.md`, `-plan-review-2026-07.md`, `-target-design-review-2026-07.md` | Supporting analysis; read if you need the reasoning behind a scoping call. |
| `.claude/workflows/akm-090-*.js`, `akm-0.9.0-execution-workflow.md`, `-workflow-creation-record.md` | ⚠️ **Relics of the failed orchestration approach. Ignore or delete — do not use.** |

**Start here:** confirm scope with the maintainer (esp. the recombine/residual fold-ins), then finish **Chunk 7 (WI-7.4–7.8)** using plan §5 + §11-Chunk-7 + `execution/chunk-7/brief.md`, re-capturing any deleted improve goldens you need first.
