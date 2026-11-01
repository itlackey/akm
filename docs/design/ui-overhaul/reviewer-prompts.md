# Reviewer prompts and rubric

Source: [plan.md](plan.md) §11.5.6 and §11.3. The plan wins where this file differs. Related: [task-brief-template.md](task-brief-template.md), [seed-spec.md](seed-spec.md).

## Reviewer prompt (§11.5.6)


> You are the {VD|AX|DV} reviewer for akm ui. The spec is `docs/design/ui-overhaul/plan.md` §0, §4, §5, §7, §8.8 and §11. Compare the actual screens against **the reference screens and the spec**, not your taste. Do not edit the PR. Follow §11.5.3 in order.
>
> Output:
> 1. the automated gate status;
> 2. a diff-accounting table;
> 3. Blocking / Should / Note comments, each citing a spec line and a screenshot file;
> 4. the anchored rubric table with evidence (§11.3), for your dimensions only;
> 5. the verdict (approve / changes requested), the round number and the artefact hash.
>
> At most 3 rounds (§11.5.5).


## Anchored rubric (§11.3)

- Each score needs **one sentence of evidence citing a screenshot file name**; a score without evidence is invalid.
- A dimension's score is the mean across the reviewers who scored it.
- The objective check must pass before a score of 4 or more is allowed.

| Dimension | 1 | 3 | 5 | Objective check (required for ≥ 4) |
|---|---|---|---|---|
| Clarity | Numbers without unit, window or n | Most numbers labelled | Every number states what, the window and n | Copy audit: every stat has a window chip in its region |
| Hierarchy | Main job below the fold; several primaries | Main job visible, but secondary content competes | Main job above the fold at 1440×900; exactly one primary; attention before trends | Playwright: the main-job region top < 900; primary count = 1 |
| Consistency | Page-local styles; new-looking controls | Tokens used, but ≥ 1 control differs from the gallery | Every control is a gallery component; spacing follows the rhythm table | Computed-style audit: 0 off-token values |
| Feedback and states | Blank areas; focus lost | All states exist, but some are generic | All six states designed; focus never lost; each action reports its result in place | Focus assertions; state strip captured; CLS ≤ 0.05 |
| Efficiency | Needless confirms; no keyboard path | Targets met by mouse only | §2 step counts met; keys work; confirms only for the irreversible | The keyboard trace meets the §2 counts |
| Learnability | Jargon without explanation | Some terms explained | Every glossary term explained at first use; empty states teach the next action | Scan: each glossary key on the page has a `term()` |
| Aesthetics | Misaligned, cramped or decorative | Aligned, but density is uneven | Calm: shared edges, one radius family, colour only for data, status and accent; no nested cards | Grid overlay shows shared edges; `.card .card` count = 0 |
| Accessibility | Keyboard or screen-reader blockers | AA with workarounds | WCAG 2.2 AA; forced colors usable; the table equivalent is complete | axe 0; 2.4.11; aria snapshot reviewed |
| Data honesty (charts) | Rates below min-n drawn; causal words | min-n respected, but the tier or partial bins are missing | All of §5.0 R1–R12 | SSR low-n tests pass; forbidden-word scan 0; no difference field in Linked payloads |

