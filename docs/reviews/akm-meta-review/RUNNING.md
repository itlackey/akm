# Running a meta-review session

Each review runs in its **own fresh session**, driven by the model-tiered runner
`run-review.workflow.mjs`. The runner enforces the model policy so you never pick models:

| Phase | Model | Role |
|---|---|---|
| Gather | `sonnet` (Explore, read-only) | mechanical, high-context evidence collection |
| Analyze | `fable` | the judgment / verdicts / design |
| Verify | `opus` | adversarial challenge (only for reviews flagged adversarial) |
| Synthesize | `fable` | writes `findings/NN-slug.md` in the prompt's shape |

Around that automated core you keep the two human-in-the-loop steps that worked for 01 and 05:
a **sealed prediction before** the run, and an **owner adjudication after**.

## How to run one

1. Pick the next review from the status table below.
2. Copy the **session prompt** and replace `{{REVIEW}}` with its two-digit number and
   `{{SEALED_QUESTION}}` with its row from the **sealed questions** table.
3. Paste it into a fresh session.

---

## Session prompt (copy, fill the two `{{…}}` slots, paste)

```
Run akm meta-review {{REVIEW}} using the model-tiered runner. One review per fresh session.

STEP 0 — SEAL MY PREDICTION FIRST, before you read any code or launch anything.
Ask me exactly one question (via AskUserQuestion) and store my answer ONLY in your
scratchpad. Never put it into any agent, the workflow args, or any file the review
touches — it must stay out of all agent context so it can't bias the run:
  "{{SEALED_QUESTION}}"
You'll compare it against the analysis at the very end.

STEP 1 — Run the review via the workflow (pasting this authorizes the orchestration):
  Workflow({ scriptPath: "docs/reviews/akm-meta-review/run-review.workflow.mjs",
             args: { review: "{{REVIEW}}" } })
The runner enforces the model policy — you do NOT pick models: Explore+sonnet gathers
evidence read-only, fable does the analysis and writes the findings, opus runs the
adversarial verify pass (when the review has one). It writes the findings under
docs/reviews/akm-meta-review/findings/.

GROUND RULES (the workflow enforces these; you enforce them too): READ-ONLY on live data
— never run akm improve/recombine/extract/consolidate; sqlite mode=ro only. Findings are
gitignored, local-only, may contain sensitive facts — NEVER commit or push them. Prefer
subtraction over adding machinery.

CARRY FORWARD (binding decisions from earlier reviews; update as later reviews adjudicate):
- akm is BOTH pillars: a pack-consumption channel AND a learning engine; the automation
  platform (tasks/env/secrets) is a ratified 1.0 pillar.
- Metrics are settled: UCE (useful context events/week) is the primary north star; GRR
  (per-lane 30-day external read-back rate of improve-promoted refs) is the governing
  number; minting lanes stay off below 5% GRR.
- Generation is gated on usage/feedback; proactive lanes are repointed at ENRICHMENT
  (metadata, graph relations), not new-content minting.
- The improve pipeline ALREADY had a subtraction round — PR #695 (shipped 0.9.0-beta.54)
  deleted the #691 outcome-penalty term and added event-provenance filters, two-tailed
  monitors, and an enrichment-minting rollup. R1 (outcome weight w_o=0.15) and R2
  (salience→search boost) are LIVE since beta.53. Account for what's already gone; don't
  recommend re-deleting it.
- Metrics caveat: improve accept/reject rows before 0.9.0-beta.50 are polluted (gated
  skips counted as rejected) — discriminate with `skippedCount IS NOT NULL`.
- Security: the env comment-leak is fixed and the index rebuilt; the previously-leaked
  credentials were fake test values — no rotation needed.

STEP 2 — After the workflow returns:
1. Read the findings doc. Add a section comparing my SEALED prediction to the analysis's
   verdicts — where they match, where they diverge, and why (same process as 01/05).
2. Give me the headline finding and the top dispositions/rankings, in the shape this
   review's prompt specifies.
3. Interview me to adjudicate: which items I approve / defer / reject. Record my decisions
   in an "Adjudication" section of the findings doc.
4. Do NOT execute any change and do NOT commit the findings — this pass produces analysis
   and decisions only.
```

---

## Sealed questions (one per review)

Pick the row for the review you're running and paste it into `{{SEALED_QUESTION}}`.

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

---

## Status & order

Done: **01** goal-orientation, **05** metrics-and-evals (both adjudicated + shipped).

Suggested order for the rest:

- **Core system audits (next):** 02 bitter-lesson → 03 memory-compounding → 04 self-model → 06 autonomy.
- **Security pair:** 07 injection, 08 attack-surface (run back-to-back).
- **Direction:** 09 steelman → 10 what-10×s → 12 constraint (09 before 10 — attack the bets before planning around them).
- **Housekeeping:** 11 policy, 13 bus-factor, 14 docs, 15 loop.

After a review adjudicates, fold its binding decisions into the **CARRY FORWARD** block above
so later reviews inherit them.
