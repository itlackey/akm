# Deviation Analysis — 0.9.0 plan vs the format-neutral spec + decision history

**Compared:**
- **Spec** = `akm-format-neutral-bundle-workspace-spec.md` (normative RFC, MUST/SHOULD).
- **History** = `akm-architecture-decision-history.md` (decision register D1–D26 + superseded-choices table).
- **Plan** = `akm-0.9.0-bundle-adapter-architecture-plan.md` + `akm-0.9.0-bundle-adapter-spec.md` + the residual/greenfield/survivor companions.

**Bottom line:** the plan agrees with the spec on the *foundations* (format-neutral, adapters own semantics, one local index, direct reads, proposals=FileChange[], evidence-driven improve, modular replacement, three DBs, one-time rekey). The deviations cluster in two places: **(A) my `§13.3` "scope-down the plan's own additions,"** which conflicts with spec-required subsystems the History classifies as refactors-not-additions; and **(B) your later OKF/`type` instruction,** which conflicts with the History's D2. Both are flagged for your decision.

---

## 0. Where plan and spec AGREE (no action)

Format-neutrality and removal of the closed asset taxonomy (spec §4/§6, D1); adapters own recognition/conventions/authoring/validation (D4); narrow `IndexDocument`, no semantic-view registry (D10, spec §4.6); search is local + adapter-free at query time (D11); direct reads by indexed path, no `adapter.read()` (D13); indexing never mutates bundles (D14); `Proposal` = `FileChange[]` + before-hash, one transaction (D15/D16, spec §23); model confidence ≠ authority (D17); evidence-driven improve with one snapshot + verification ladder (D18/D19, spec §24); modular replacement in-repo, no greenfield, no permanent legacy adapter (D25); three DBs, workflow.db merged (D26); website first-class + export (D7); FTS-weight parity gate before ranking changes (D12). The plan matches all of these.

---

## 1. MAJOR deviations

### DEV-1 — OKF: "foundational metadata format" (plan) vs "flagship adapter, NOT the kernel schema" (spec/History D2). Also `type` (plan) vs `kind` (spec).

**Spec/History position (explicit):** "OKF is a flagship adapter and preferred interchange format, **not AKM's internal schema and not an asset type**" (History §2 #1, **D2**). The superseded-choices table lists **"Use OKF as AKM's hidden universal object model" → REJECTED** ("creates translation loss and makes the standard carry AKM concerns"). The normalized model field is **`kind?: string`**, "descriptive adapter metadata," which **"MUST NOT select storage, execution, rendering, or write behavior"** (spec §14.1).

**Plan position (my current bundle-adapter-spec):** OKF is the **foundational** metadata format; AKM is OKF-compatible **by default**; the field is **`type`** (the OKF field), and it *does* key presentation (`TYPE_PRESENTATION`) and type-specific validation.

**Why the plan deviates:** your later instructions — "OKF is the foundational metadata format… AKM is OKF-compatible by default," and "why not just use `type`." I implemented those directly.

**This is a genuine, load-bearing contradiction between your earlier design (these docs) and your later instruction.** The two positions are not reconcilable by wording; they are different architectures:
- *History D2:* OKF is one adapter among many (OKF, LLM Wiki, Claude, …); the kernel is format-neutral; `kind` is opaque and drives nothing.
- *Your later direction:* OKF is the base metadata contract the kernel projects into; `type` is the shared descriptor and drives rendering/ranking/validation.

**Note:** the two are closer than they look — even under D2, OKF is the *preferred* interchange format and the reference adapter, and `IndexDocument` fields already mirror OKF (`name`←title, etc.). The real fork is (a) does the **kernel** commit to OKF semantics (your later view) or stay strictly neutral with OKF as one plug-in (D2); and (b) is the field **`type`** (OKF, drives behavior) or **`kind`** (opaque, drives nothing). **Needs your decision** (see §4).

### DEV-2 — ItemRef: two segments (plan) vs three segments (spec/History).

**Spec/History:** canonical ref is **`<bundle-id>/<component-id>/<adapter-local-id>`** (spec §7.8/§11.1, History §5.4). Component is IN the ref. Invariants: reclassifying an item without moving it SHOULD NOT change its ref; moving requires an explicit rekey (spec §11.2).

**Plan:** two segments **`<bundle>/<local-id>`**; component is a **provenance column**, not a ref segment (bundle-adapter-spec §1.3), explicitly rejecting the three-segment form.

**Why the plan deviates:** I argued component is reclassifiable (a manifest edit can re-mount a root under a different adapter), so putting it in the ref reintroduces the coupling drop-ref removes. The spec treats component as a **structural root** (which subtree), stable like a path, not a per-item semantic label — so it belongs in identity as a path segment.

**Assessment:** the spec's reasoning is sound: `<bundle>/<component>/<local-id>` *is* just a path, and component is as stable as a top-level directory. My 2-segment collapse saves little and loses the spec's clean "component-scoped adapter ownership in the ref." **This is a deviation I should probably revert to match the spec** unless you prefer the flatter ref. **Needs your decision.**

### DEV-3 — Bindings / activation: full core subsystem (spec) vs deferred (plan §13.3).

**Spec/History:** "**Installation is not activation**" is a core requirement (**D8**, spec §18, non-goals, acceptance criteria 9/11). Bindings are a first-class record (spec §7.10/§18.3), `Binding` is in the minimal durable core set (History §5.2), and `install → bind → enable` is the mandated lifecycle.

**Plan (§13.3):** I **scoped bindings down** — "keep implicit activation for 0.9.0; no `workspace_bindings` table / export digests / trust layer (zero consumers today)."

**Why the plan deviates:** the residual-complexity audit flagged bindings as "framework-before-second-consumer." **But this directly contradicts (a) spec D8 and (b) your own statement that these "work today, they are refactors to proper design, not additions."** Task scheduling, env injection, and workflow runs already happen at/after install today — that *is* implicit activation, and separating it is the refactor. **My scope-down is the deviation; it should likely be reverted** to keep install≠activation in 0.9.0.

### DEV-4 — Memory lifecycle: full first-class subsystem (spec §25) vs scoped-down (plan §13.3).

**Spec/History:** memory lifecycle is a **first-class product requirement** (**D21–D24**, spec §25): `MemoryLifecycleAdapter` facet, high/low-water + backpressure, active/retired/quarantined/purged states, source-to-successor **claim coverage**, retrieval non-regression, bounded content-addressed archive, purge, read-only retirement overlay.

**Plan:** two-verb improve with consolidation **folded into `learn`** as "non-destructive supersession recipes"; `§13.3` says "no one-implementer `MemoryLifecycleAdapter` facet… express it as ordinary functions."

**Why the plan deviates:** same residual-audit "framework-before-second-consumer" reasoning. **But the History is emphatic** (§10 "the largest unresolved design area"; D21 memory lifecycle stays first-class) that this is a required capability refactoring the existing `consolidate.ts` (~3,100 LOC) — again a refactor-not-addition. **My scope-down under-specifies what the spec requires.** The plan's non-destructive-supersession idea is compatible but incomplete (no water-marks/backpressure/coverage-map/archive/purge/quarantine).

### DEV-5 — Semantic verbs: two (plan) vs three (spec).

**Spec/History:** **revise / learn / consolidate** — three first-class operations (**D20**, spec §24.2, acceptance 19). Consolidate is explicitly *not* a special case of learn because it is the only op permitted to retire source content.

**Plan:** **revise / learn** (two); consolidate folded into `learn`.

**Assessment:** direct deviation; ties to DEV-4. The spec's reasoning (consolidate is the only source-retiring op, needs its own lifecycle/verification contract) is strong. **Should revert to three verbs.**

### DEV-6 — Adapter facets: facet interfaces (spec §12) vs no-hierarchy data-table (plan §13.3).

**Spec:** `BundleAdapter` base + `AuthoringAdapter` / `ExportAdapter` / `MemoryLifecycleAdapter` facets (spec §12.2–12.4).

**Plan (§13.3):** "no facet interface hierarchy… express optional capabilities as optional methods; renderer/action as a data table."

**Assessment:** **partial deviation, and here the plan is defensible.** The History's own §8.3 shows the base adapter with **optional methods** (`getAuthoringContext?`, `create?`) — closer to my "optional methods" than to rigid separate interfaces, and it calls facets "targeted ports, not semantic views." So "optional methods on one interface" satisfies the intent; "separate `extends` interfaces" is the spec's expression of the same thing. This is a naming/shape difference, not a capability loss — **lowest-stakes of the majors.** (The renderer/action-as-data-table point is compatible with both.)

### DEV-7 — LLM Wiki: deleted and folded to `knowledge` (plan) vs kept as an adapter (spec).

**Spec/History:** LLM Wiki is a **retained adapter** (spec §7.4/§13.3 "The LLM Wiki adapter owns `schema.md`, `index.md`, `log.md`, raw-source, page, citation, native ingest"; History §4.1 "remove wiki as a core *asset type*" — but keep it as an *adapter*).

**Plan:** the wiki subsystem is **deleted**; pages **fold into `knowledge`**; only broken-xref survives into base-linter.

**Why the plan deviates:** the residual/comprehensive plan treated wiki as pure deletion. **The docs want wiki-as-adapter (native `schema.md`/`index.md`/`log.md`/citations preserved), not collapsed into knowledge.** This is an over-deletion: I removed a format the spec keeps. **Should reconsider** — either restore an LLM Wiki adapter, or confirm with you that wiki→knowledge collapse is an intentional simplification beyond the spec.

---

## 2. MINOR deviations / omissions

- **DEV-8 Progressive disclosure L0/L1/L2** (spec §15.2, History §8.6) — the plan omits it. Spec wants three retrieval levels (card / overview / detail), derived artifacts in `index.db`. Not in my plan; should add.
- **DEV-9 Export refs with `#fragment`** for one item exposing multiple exports (spec §11.3) — omitted; minor.
- **DEV-10 Dual-emit for index parity** (spec Phase 3 "dual-emit temporarily for parity comparison") — my plan's "no dual-write" was about *state re-key*, but I let it read as forbidding the spec's *index-projection* parity dual-emit. These are different; index-parity dual-emit (regenerable index.db) is safe and the spec mandates it as the cutover gate. **Clarify: my no-dual-format rule does not forbid index-parity dual-emit.**
- **DEV-11 Baseline commit** — docs reference `ddc0a1b` / PR #718; my plan is baselined on the newer `cf44e11`/`b7877d9`. Mine is more current; no conflict, just note the drift when cross-referencing line numbers.

---

## 3. Where the plan ADDS beyond the docs (mostly compatible)

- **Drop-ref + full re-key, "no compat / no dual-format"** — the spec agrees on the one-time rekey (§11.4) and prohibits a permanent dual-parser; the plan's stronger "single atomic, no compat window" is compatible and more aggressive (your directive). (Caveat DEV-10.)
- **Residual-complexity audit** (echarts→CDN, net-LOC ledger, prove-or-delete tier) — compatible with spec §6.5 (complexity carries burden of proof) and §33 (deferred ablation decisions).
- **Survivor value+architecture audit; verified code-claim pass; taxonomy-fold** — additive verification work, compatible.
- **OKF-native `type`-in-frontmatter model** — additive detail, but see DEV-1 (conflicts with D2 on the schema question).

---

## 4. Resolutions (maintainer, 2026-07-13)

1. **DEV-1 OKF — HYBRID.** Format-neutral kernel (History D2 stands): OKF is the reference/default adapter, not the kernel schema; Claude/OpenCode/skill/workflow/task/env formats stay native. Adopt OKF field names incl. open **`type`** as a non-authoritative descriptor — it presents/ranks/filters but never authorizes execution or identity, and is not `kind`.
2. **DEV-2 Ref — OKF concept ID + optional `bundle//` prefix.** `ref := [<bundle>//]<concept-id>` where concept-id = path within bundle − `.md`. Component is absorbed into the path (a provenance column), not a distinct segment. Supersedes both my two-segment and the spec's three-segment form.
3. **DEV-3/4/5 — RESTORE all three.** Bindings/activation (install≠activate), the full bounded memory lifecycle (normative §25), and the third `consolidate` verb are in scope for 0.9.0. Retained simplifications: renderer/action as a data table, and adapter facets as **optional methods** on one interface (not a rigid hierarchy — History §8.3). The storage `Repository<Row,Domain>` decision is unrelated and stands (ship `jsonColumn()` only).
4. **DEV-6 Facets** — resolved by #3: capabilities restored, expressed as optional methods.
5. **DEV-7 Wiki — restore the LLM Wiki adapter.** The `wiki` asset-*type* dies; the adapter is a first-class built-in owning `schema.md`/`index.md`/`log.md`/raw/pages/xrefs/citations/ingest. No fold to `knowledge`.
6. **Minor (DEV-8/9/10)** — add progressive disclosure L0/L1/L2, export `#fragment` refs, and clarify that "no dual-format" does not forbid index-parity dual-emit during cutover.

Applied to: the reconciled `akm-0.9.0-bundle-adapter-spec.md`, and the plan's reconciliation banner + §5/§6/§13.3/Chunk-4 edits.
