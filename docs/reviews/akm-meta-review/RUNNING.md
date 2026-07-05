# Running a meta-review session

One review per fresh session. The runner `run-review.workflow.mjs` does the analysis under a
fixed model policy; you keep the two human-in-the-loop bookends — a **sealed prediction before**
and an **adjudication after**. Shared context (ground rules + binding decisions) lives in
[`CONTEXT.md`](./CONTEXT.md) and is auto-read by the workflow's agents — nothing to copy-paste.

| Phase | Model | Role |
|---|---|---|
| Gather | `sonnet` (Explore, read-only) | mechanical, high-context evidence collection |
| Analyze | `fable` | the judgment / verdicts / design |
| Verify | `opus` | adversarial challenge (reviews flagged adversarial only) |
| Synthesize | `fable` | writes `findings/NN-slug.md` in the prompt's shape |

## Start a session

In a fresh session, say (replace `NN` with the two-digit review number):

> **Run meta-review NN following docs/reviews/akm-meta-review/RUNNING.md**

The session then does:

**0 · Seal my prediction — before launching anything.** Ask me the sealed question for `NN`
from the table below (via AskUserQuestion). Store my answer ONLY in scratchpad; never put it in
any agent, the workflow `args`, `CONTEXT.md`, or any file the review touches — it must stay out
of all agent context so it can't bias the run.

**1 · Run the workflow** (issuing this authorizes the orchestration):

    Workflow({ scriptPath: "docs/reviews/akm-meta-review/run-review.workflow.mjs",
               args: { review: "NN" } })

The runner enforces the model policy and writes `findings/NN-slug.md`. Its agents auto-read
`CONTEXT.md` for ground rules + carry-forward. Findings are gitignored — never commit them.

**2 · After it returns.** Read the findings doc; add a section comparing my sealed prediction to
the analysis (match / diverge / why); give me the headline plus the top dispositions in the shape
that review's prompt specifies; interview me to adjudicate (approve / defer / reject) and record my
decisions in an **Adjudication** section. Then append the binding decisions to `CONTEXT.md`'s
*Carry forward* so later reviews inherit them. Execute nothing; commit nothing.

## Sealed questions (one per review — used in step 0; keep OUT of agent context)

| # | Sealed prediction to ask the owner |
|---|---|
| 02 | Which single hand-engineered heuristic in akm are you most confident a better model soon makes obsolete (DIES first) — and which are you most confident it never will (LIVES longest)? |
| 03 | What fraction of your stash do you believe is write-only (captured but never resurfaced) — and is the stash getting smarter as it grows, or just bigger? |
| 04 | What is the single most out-of-date thing the stash still believes about you or your projects? |
| 06 | Which autonomous improve action are you least comfortable running unsupervised — and which owner-gate do you think costs more than it protects? |
| 07 | What is the single most dangerous path by which poisoned content could reach a future session's instructions — and do you believe it's exploitable today? |
| 08 | Which stored surface (which store, secret, or integration) would hurt most if exposed — and which do you think is least protected today? |
| 09 | Which of akm's founding bets are you most afraid is wrong — and would your current telemetry even let you notice if it were failing? |
| 10 | Which akm subsystem do you expect frontier models to make obsolete first — and what is the one thing akm does that a long-context model still can't do for you? |
| 11 | Which decision do you re-make every session that should already be automated or enforced — and is it currently enforced, or just documented? |
| 12 | What single bottleneck most caps akm's value to you right now — and has recent effort actually been aimed at it? |
| 13 | What about your akm setup would silently break first if you switched machines tomorrow? |
| 14 | Which akm subsystem's documentation do you trust least to match the code today? |
| 15 | What is the one recurring maintenance task you'd most want a standing loop to own — and what hard gate must it never cross? |

## Status & order

Done: **01** goal-orientation, **05** metrics-and-evals (adjudicated + shipped); **02** bitter-lesson,
**03** memory-compounding, **04** self-model, **06** autonomy-ladder, **07** prompt-injection,
**08** attack-surface, **09** steelman-the-bets, **10** what-10×s-what-dies, **11** decisions-into-policy,
**12** one-real-constraint, **13** bus-factor, **14** docs-consolidation (adjudicated — dispositions
only; see CONTEXT.md carry-forward; 14's approved doc-sync edits form their own batch).

- **Core system audits:** ~~02 → 03 → 04 → 06 autonomy~~ — DONE.
- **Security pair:** ~~07 injection → 08 attack-surface~~ — DONE.
- **Direction:** ~~09 steelman~~ → ~~10 what-10×s~~ → ~~12 constraint~~ — DONE.
- **Housekeeping:** ~~11 policy~~ → ~~13 bus-factor~~ → ~~14 docs~~ → 15 loop (LAST remaining).
- **⚠ 12-D3 execution batches 1+2 SHIPPED & DEPLOYED** (beta.58 live in cron, 2026-07-05). Remaining before 14/15:
  the deferred **minting-shutdown batch** (re-baseline via `findings/09-grr-receipt.sql.md` first) and the
  **13 execution items** (A1 profiles/fallback, C1 skip-sweep aggregation, C2 failRate advisory + exit-143 triage,
  B1/A3 docs, D1 path-normalization + lint, approved per-path trash). See CONTEXT.md "From 13".

## Execution batches

- **Batch 1 (2026-07-04) — PARTIAL, see CONTEXT.md "EXECUTION BATCH 1".** 11 akm commits + 1 akm-plugin commit
  (branch `meta-review-exec-2026-07-04`), all gate-green + adversarially reviewed. Shipped: 02 dead-key,
  06-M4/M7, 03-R4, and the whole 07/08 security surface (transcript fence, toolPolicy ceiling, env/secret
  refusal, backups 0600, stash-git-exposure + gitignore) plus the plugin SubagentStart/re-injection hardening.
  BLOCKED: 07-P0-2 fail-CLOSED (ready+proven, needs a distill/reflect test migration — **do first**).
  RE-SCOPE: 10-Q3 staleness-detect (owner confirm). REMAINING: 03 belief-guard/derived/one-edge + 02 ablation
  (curate-golden-gated) + opencode-sdk sessionLogs reader. **Deferred carve-outs (minting shutdown) untouched.**
  Needs owner release: `bun run build` + reinstall global (~beta.58) before the akm fixes protect cron.
