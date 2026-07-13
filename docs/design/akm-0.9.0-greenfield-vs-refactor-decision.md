# Greenfield vs In-Place: The Delivery Call for AKM 0.9.0

**Recommendation: B — in-place modular replacement (the current plan). Reject A (separate greenfield). Fold the useful half of C into B; do not build a parallel `src/` tree.**

The call is not close. The plan is already the right shape.

## The survivor math is decisive

Actual HEAD: **~133,600 src LOC / 474 files; ~169,000 test LOC / 576 files** (larger than the 107K/410 the prior docs quote — the codebase grew, which only strengthens the "mass is real" point). Against that mass, total deletions across *both* the plan and the residual audit are:

| Bucket | LOC |
|---|---|
| Plan net removal (§12 ledger) | ~9,000–10,500 |
| Residual audit, confident-now | ~4,300 + 1 MB asset |
| Residual audit, prove-or-delete (conditional) | up to ~12,000 |
| **Absolute maximum** | **~27,000 (~20% of src)** |
| **Realistic (plan + confident residual)** | **~14,000 (~10%)** |

So **80–90% of the repo survives to 1.0**, and the survivors are the load-bearing infrastructure, verified by direct measurement:

- indexer / embeddings / FTS / ranking — **14,801 LOC** (explicitly "leave it alone")
- workflows / frozen-plan runtime — **15,394 LOC** (KEEP minus the ~426 workflow.db merge)
- improve — **28,513 LOC**, of which the plan removes only ~3,900 *net*; the rest is **decomposed and kept** as passes. Even the "primary debt center" mostly survives.
- storage / SQLite hardening + migration ledger — **3,778 LOC**
- sources / SSRF + materializers — **3,591 LOC**
- harness / engine runtime — **5,332 LOC**
- tasks / scheduler backends — **2,741 LOC**

Deletions concentrate in exactly one place: the asset-taxonomy / `type:name` ref / improve-orchestration center. **That center is precisely what B (and greenfield) both replace with new modules.** Greenfield's only marginal gain over B is "no old baggage behind the boundary" — but the plan's zero-count grep gates (`TYPE_DIRS`, `AkmAssetType`, `parseAssetRef`, `StashEntry`, `wikiName` → 0) plus drop-ref + full re-key **delete that baggage in-place anyway.** Greenfield buys nothing there and pays to re-home the untouched 80%.

## The five decisive reasons

1. **Survivors dominate ~4:1 and are load-bearing.** Greenfield would rewrite the ~10–20% that B already replaces as new code, *plus* be forced to re-port/re-review the ~80% (~40K+ LOC of infra) that is not changing responsibility. That is strictly more work for the same architecture.

2. **The "valley of no value" is deep and one-sided.** Greenfield delivers zero user value until writeFileAtomic + path/symlink containment, the SQLite migration ledger + pragmas, git exact-path staging, credential redaction, the 5.3K-LOC engine/harness runtime, the 15.4K-LOC workflow frozen-plan engine, the 2.7K-LOC scheduler backends, and the 14.8K-LOC embeddings/FTS/ranking core are all ported and green. B delivers per vertical slice.

3. **Greenfield gets no migration or data advantage — the plan already pays that cost under B.** The plan drops the ref, does a **one-time atomic full re-key** (`state-018`, backup-verified, fail-closed), and treats the current code as **test-oracle + migration source**. That re-key/migration cost is identical under all three options. Greenfield *adds* to it: a second product's CI, release, feature-freeze, dual bug-fixing, and behavior-comparison tooling, for no offsetting saving.

4. **The residual-complexity findings cut *against* greenfield, not for it.** Almost every finding is a *deletion* — a vendored 1 MB `echarts.min.js`, a duplicate workflow codec, dead lanes, an env-gated embedder, a one-element plugin loader. Deletions are trivially cheaper in-place (`rm` a file, land a grep gate) than "decline to port" in a greenfield where you must first rebuild enough to know what you're declining. Worse, ~12,000 LOC of it is **prove-or-delete**, resolvable only by running the existing nDCG/MRR/saturation harness against the existing corpus and the code's own tripwire (`outcome-loop.ts:56` `corr=+0.0104`). Greenfield would have to rebuild that measurement apparatus just to learn what not to build. "So much is deletable" is an argument for a debt sweep on a good foundation, not for discarding the foundation.

5. **Safety behavior lives in the survivors and the ~6,000 tests, and it is not recoverable from a design doc.** This is a credential-handling, path-containing, SQLite-concurrent, migration-performing CLI. Years of path/SSRF/concurrency/migration/credential edge cases are encoded in the 169K test LOC and the infra they pin. Greenfield re-earns every one — the classic rewrite failure mode. doc3 §26/§28 mark this infra and its behavior tests as explicitly non-sacrificial.

## Strongest counter-argument for greenfield — and why it loses

*"The conceptual center is genuinely changing — stash/assets/types → workspace/bundles/files — and the `type:name` ref is the coupling spine threaded through nearly every subsystem (doc3 §6.1). The plan itself concedes a full re-key and uses the old code only as an oracle. You are paying rewrite prices already; pay them once, cleanly, without dragging a 133K-LOC tree behind you."*

It loses on a category error. The re-key is a **one-time state migration**, not a rewrite of the 80% infra body. The coupling spine is **deleted in place** by the grep gates; greenfield does not delete it any more completely — it merely forgoes reuse of everything correct that is attached to it. The conceptual change is real, but it is a change at the **boundary** — identity, adapters, proposal/FileChange transaction, improve orchestration — and B builds that boundary as fresh modules exactly as greenfield would. You get the same clean boundary either way; only greenfield also pays to reconstruct the parts that were never the problem.

## Why B over C (fresh internal foundation, same repo)

C shares the repo, CI, tests, and data with B, so it avoids A's dual-product tax — it is the strictly better *form* of greenfield. But C still relocates proven infra into a new tree, forcing needless churn and re-review on ~40K+ LOC (search/workflow/storage/sources/tasks) whose responsibility is unchanged, and it reintroduces a mini valley: the new foundation does nothing until enough subsystems are ported in. **B already absorbs C's one good idea** — it builds the replaced center (the 14 bundle adapters, `RunContext`, `Proposal{FileChange[]}`, the transaction) as *new modules*, not as mutations of `AssetSpec`, and deletes old slices at cutover per the deletion ledger. That is "fresh foundation for the parts that need it, in place, without moving the parts that don't." Choosing C over B would trade that surgical property for gratuitous relocation.

## The conditions under which greenfield WOULD be correct

Reconsider A only if the **first one or two vertical slices** establish *all* of the following:

1. The retained subsystems prove **harder to decouple than to recreate** — i.e., repointing search/workflow/storage off `TYPE_DIRS`/`StashEntry` costs more than rewriting them.
2. The **1.0 scope collapses** to a small fraction of current AKM (drop workflows, tasks, scheduler, website ingest, graph) — so there is little infra worth porting.
3. **Search and state compatibility are abandoned** — no re-key required, index rebuilt from scratch, users accept a clean break with no data migration.
4. A replacement slice demonstrates a **several-fold size reduction without any compatibility scaffolding.**
5. The current suite is judged to encode **mostly obsolete-ownership behavior** rather than durable safety invariants.

None of these hold today: measurement shows the infra is separable (the plan repoints it via `RunContext` and adapter `directoryList()`), scope is still broad, a full re-key is planned *because* state compatibility matters, and the test suite is dominated by exactly the path/credential/concurrency invariants doc3 §28 says to preserve.

## Verdict

Execute the current in-place plan (**B**). Fold the confident residual deletions into its chunks now; gate the prove-or-delete tier on one harness run as a 0.9.1 pass; hold the plan's own new machinery (bindings / facets / second supersession path) to the scoped-down alternatives. **Do not open a second repo, and do not stand up a parallel `src/` tree.**
