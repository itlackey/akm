# Chunk 6.5 — execution ledger — RETROACTIVE

> **RETROACTIVE LEDGER — reconstructed 2026-07-21 from git history; NOT a
> contemporaneous record.**
>
> **Why this exists:** the 2026-07-21 0.9.0 close-out audit found chunks 3, 4, 5,
> and 6.5 landed real code but never committed the per-chunk execution ledger the
> chunk-manifest's hard gate #4 requires. `git log --grep=ledger` shows ledger
> commits for chunks 0b/1/1.5/2/8/9/10 but none for 3/4/5/6.5. This backfills
> chunk 6.5.
>
> **Evidence classes** (every claim traces to one):
> - **[COMMIT]** — commit hash + `git show --stat` subject/body/diffstat.
> - **[GREP@HEAD]** — grep/command run at HEAD `e3eec904`
>   (branch `claude/akm-architecture-refactor-fubvd7`) on 2026-07-21.
> - **[DOC]** — quote from a committed document.
> - **NO RECORD** — not answerable from the record; not reconstructed.
>
> **Could NOT be reconstructed:** contemporaneous Opus review verdicts, the
> mid-chunk gate logs, batteries-at-close totals, and — critically — **the DoD-10
> "port-preservation" audit trail** (see §DoD-10). This chunk landed as a **single
> commit** (`56004179`), so there is no staged review history to reconstruct.

Chunk 6.5 — **"Activation policy (Tier A — install≠activate consolidation)"**
(manifest id `"6.5"`, order 12, wave 2, branch-of-record `akm-090/chunk-6.5`;
landed on `claude/akm-architecture-refactor-fubvd7`). Plan §11 Chunk 6.5, §1.3,
§12.3 (port-preservation / DoD 10), §12.4 (scope creep), deviation §4.3a–3c,
decision D30.

## Landed work items

Attributed by `git log --oneline --all --grep="chunk-6.5"` — **exactly one commit**
(no `chunk 6.5` / `chunk-6_5` spelling matched anything else).

| Commit [COMMIT] | Date | Headline |
|---|---|---|
| `56004179` | 2026-07-18 | Consolidate the four scattered "installation ≠ activation" enforcement points into one pure-leaf `src/core/activation-policy.ts`, behavior-preserving. |

The commit body [COMMIT] names the four ports, verbatim:
1. `env-binding.ts` — dangerous env-key injection block(third-party)/warn(first-party) → `decideDangerousEnvInjection`
2. `add-cli.ts` — freshly-installed stash dangerous-key scan gate/warn-allow/allow → `decideDangerousKeyInstall` (interactive confirm/rollback UX stays in add-cli)
3. `tasks/runner.ts` — scheduler fire-time `enabled:` gate → `shouldSkipUnactivatedTask`
4. `search-source.ts` / `installations.ts` — registry-cached read-only write policy → `isSourceWriteActivated`

Body also asserts: *"core/activation-policy.ts imports nothing from the tree (no
new import edges, cycle ratchet unchanged at 10). No new trust/approval machinery
(§1.3): no labeling, clamps, confirm prompts, digests, trust records, or
workspace_bindings. env/secret handling unchanged."*

### Actuals (from the single diffstat) [COMMIT]

| Commit | +ins | −del | files |
|---|---|---|---|
| `56004179` | 248 | 10 | 7 |

Files touched [COMMIT]: `src/commands/env/env-binding.ts` (14), `src/commands/sources/add-cli.ts` (11),
`src/core/activation-policy.ts` (**+127, new file**), `src/indexer/installations.ts` (3),
`src/indexer/search/search-source.ts` (5), `src/tasks/runner.ts` (3),
`tests/core/activation-policy.test.ts` (**+95, new test**).

**Net LOC = +238.** Manifest target: `netLoc: "+200 to +400"`. **Within budget** —
consistent with "decision logic consolidates; interactive confirm/rollback UX in
add-cli stays where it is."

## New / consolidated surfaces [COMMIT] [GREP@HEAD]

- **New:** `src/core/activation-policy.ts` — confirmed present at HEAD, **127
  LOC** [GREP@HEAD: `wc -l`]. Matches the manifest's ~150-LOC scope tripwire and
  the commit's `+127`.
- **New test:** `tests/core/activation-policy.test.ts` (+95) — confirmed present.
- **Consolidated (ports):** the four decision points above route through the new
  leaf; the source files retain their UX/wiring, per scope.

## Gate results — verified at HEAD `e3eec904` on 2026-07-21 [GREP@HEAD]

| Manifest gate | Command run | Result |
|---|---|---|
| Install≠activate **port-preservation tests green** (§12.3, DoD 10) | `bun test tests/core/activation-policy.test.ts` | **12 pass / 0 fail, 20 expect() calls, 168ms** (run 2026-07-21 at HEAD). The suite proves "install-grants-nothing-until-enable" across the four rules per the commit body. **PASS as a live test today.** But this is a *unit conformance suite for the new leaf*, not an independently-recorded DoD-10 port-preservation audit — see §DoD-10. |
| No new trust/approval machinery (§1.3): no labeling, clamps, confirm prompts, digests, trust records | commit body assertion [COMMIT] + `bun scripts/lint-import-cycles.ts` | Commit body asserts none added; cycle ratchet "unchanged at 10". At HEAD the cycle baseline is `0` [GREP@HEAD]. **PASS** (per commit assertion; no new-machinery grep independently run — the claim is that *nothing* was added, which a grep cannot positively confirm). |
| Scope tripwire: STOP if threading source/trust context exceeds ~150 LOC (§12.4) | `wc -l src/core/activation-policy.ts` | **127 LOC — under the ~150 tripwire.** Net chunk +238 is within the +200/+400 budget. **PASS.** |

## DoD-10 "port-preservation" — the audit-trail gap (REQUIRED record)

The manifest's headline gate is that the consolidation is a **behavior-preserving
port** of existing enforcement (plan §12.3 DoD 10). **This claim has no
contemporaneous audit trail.** State this explicitly:

- The chunk landed as a **single commit** with **no per-chunk ledger, no brief,
  and no recorded before/after behavioral-equivalence proof**. The only evidence
  the ports are behavior-preserving is (a) the commit body's *self-assertion*
  ("behavior-preserving", "env/secret handling unchanged") and (b) the new
  conformance test — which asserts the *consolidated* behavior, not that it
  matches the *pre-port* behavior at the four original sites.
- **There is no record** of: a shadow/parity comparison against the pre-port
  decision points; whether the four original call-sites' edge cases (e.g.
  first-party vs. third-party env split, the `.env`-suffix scan narrowness, the
  `enabled:` fire-time semantics) were each diffed; or any Opus review sign-off on
  the port fidelity. **DoD-10 port-preservation is therefore ASSERTED, not
  AUDITED, in the surviving record.**

### What CAN be verified now [GREP@HEAD]

- `src/core/activation-policy.ts` **exists**, **127 LOC**.
- `bun test tests/core/activation-policy.test.ts` → **12 pass / 0 fail** (2026-07-21).
- The four named source files (`env-binding.ts`, `add-cli.ts`, `runner.ts`,
  `search-source.ts`/`installations.ts`) were touched by `56004179` [COMMIT].

That is the full extent of what today's tree substantiates.

## Deviations from manifest scope

- **NO RECORD** of any deviation, re-scope, or scope-tripwire trip. The 127-LOC
  leaf sits under the ~150-LOC stop threshold, so the §12.4 tripwire did not fire
  — consistent with a clean single-commit landing.
- **Accepted-by-design residual [DOC manifest]:** "workflow refs resolve across
  installed sources and re-read current disk content per invocation — crontab
  semantics" — documented, not gated; no record it was separately verified.

## Deferrals / downstream state

- **Tier B deferred indefinitely [DOC manifest]:** `workspace_bindings` record,
  digests, rebind-on-update, `akm bind|unbind|bindings` CLI. Not attempted here by
  design.
- Downstream: env/secret handling stated "unchanged"; the config-migration
  interaction ("env injection … still hard-blocks dangerous keys AFTER the config
  migration", DoD-10 clause) depends on chunk 8's config migration — its
  post-migration verification is **NO RECORD** in this chunk.

## NO RECORD (declared gaps — not reconstructable)

1. **DoD-10 port-preservation audit** — no before/after parity proof; the claim is
   a commit self-assertion (§DoD-10 above). Primary gap.
2. Contemporaneous **Opus review verdict** for the single commit.
3. **Batteries-at-close** — no `bun run check` totals recorded for this chunk.
4. The **post-config-migration** dangerous-key hard-block verification (DoD-10
   clause) — depends on chunk 8; not recorded here.
5. Any **mid-chunk** iteration (the single-commit landing leaves no staged history).
