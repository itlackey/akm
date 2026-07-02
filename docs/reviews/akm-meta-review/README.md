# AKM Meta-Review Prompt Set

An adaptation of Daniel Miessler's ["10 Prompts to Run When Fable Comes Back"](https://danielmiessler.com/blog/prompts-to-run-when-fable-comes-back) (stashed snapshot: `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`) into a full meta-review of **akm itself**. The blog's premise — spend maximum-intelligence model time on META-work that upgrades the system, not on individual tasks — maps cleanly onto akm, because akm *is* the harness's memory-and-knowledge layer.

Each file is a self-contained review prompt. Run one per fresh session:

```
Read docs/reviews/akm-meta-review/<NN>-<slug>.md and execute the prompt it contains.
```

or paste the fenced Prompt block directly. Prompts end with `ultracode` (multi-agent orchestration opt-in); drop that word to run one solo. Each prompt writes its report to `docs/reviews/akm-meta-review/findings/<NN>-<slug>.md`. **Findings are local-only (gitignored):** they analyze the owner's live install and may contain security-sensitive facts; durable copies belong in private memories, not this repo.

## Ground rules (embedded in every prompt; stated once here in full)

1. **READ-ONLY on live data.** Inspect `~/.local/share/akm/` databases, cron logs, and `~/.config/akm/config.json` freely — but NEVER trigger `akm improve` / `recombine` / `extract` / `consolidate` runs against live data. Reviews observe; they do not generate.
2. **No deletions.** Every prompt outputs *dispositions* (keep / update / merge / archive / delete). The owner approves any delete per-path, by name, before anything is removed.
3. **Verify EFFECTIVE config, not code defaults.** A code default is inert if the live `config.json` or the cron's `--profile` pins another value. Always check what the cron actually loads.
4. **Prefer subtraction.** A recommendation that deletes machinery beats one that adds machinery. Adding a guard/flag/wrapper to work around a problem is a red flag that the root cause is unaddressed.
5. **Metrics caveat.** Improve accept/reject metrics before `0.9.0-beta.50` are polluted (gated skips were counted as "rejected"). Discriminate old vs. new rows with `skippedCount IS NOT NULL`.

## The prompts

| # | File | Adapts (blog) | The question for akm |
|---|------|---------------|----------------------|
| 01 | `01-goal-orientation.md` | Goal orientation | What is akm ultimately for, and which subsystems pull against it? |
| 02 | `02-bitter-lesson.md` | Bitter lesson optimization | Which hand-engineered heuristics will better models obsolete? |
| 03 | `03-memory-compounding.md` | Memory that compounds | Where does captured knowledge go to die instead of resurfacing? |
| 04 | `04-stash-self-model.md` | Self-model audit | Does the stash model the owner as they are now, or as they were? |
| 05 | `05-metrics-and-evals.md` | What does "better" even mean | What is the real success metric, and what evals guard it? |
| 06 | `06-autonomy-ladder.md` | The autonomy ladder | What does improve do unsupervised vs. queue for approval — and is that calibrated? |
| 07 | `07-prompt-injection.md` | Prompt injection handling | Stored content is re-injected into future sessions — how poisonable is that path? |
| 08 | `08-attack-surface.md` | Deployed infrastructure audit | Full inventory of akm's installed/deployed/secret surface. |
| 09 | `09-steelman-the-bets.md` | Where am I most wrong | Steelman the case that akm's biggest bets are wrong. |
| 10 | `10-what-10xs-what-dies.md` | What 10×s and what dies + Big picture | Given frontier AI's trajectory, which subsystems die, which are the wedge, what is 1.0? |
| 11 | `11-decisions-into-policy.md` | Decisions into policy | Which decisions get re-litigated every session, and where should each be encoded once? |
| 12 | `12-one-real-constraint.md` | The one real constraint | The single binding bottleneck on akm's value — not the loudest problem. |
| 13 | `13-bus-factor.md` | The bus-factor audit | What only works because it's in the owner's head or on this one machine? |
| 14 | `14-docs-consolidation.md` | Blog consolidation (adapted) | Consolidate the scattered design/technical/plan docs into one canonical map. |
| 15 | `15-maintenance-loop.md` | Peter Steinberger's loop prompt | Design a standing repo-maintenance loop for akm with hard gates. |

## Suggested order

- **First (they feed everything else):** 01 goal, 05 metrics. You can't judge alignment or improvement without the goal and the metric.
- **Core system audits:** 02 bitter-lesson, 03 memory-compounding, 04 self-model, 06 autonomy.
- **Security pair:** 07 injection, 08 attack surface (07 is content-level, 08 is infra-level; run back-to-back).
- **Direction:** 09 steelman, 10 what-10×s, 12 constraint (09 before 10 — attack the bets before planning around them).
- **Housekeeping:** 11 policy, 13 bus-factor, 14 docs, 15 loop.
