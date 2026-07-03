# 15 — The maintenance loop: a standing repo-maintenance harness for akm

> Adapts **Peter Steinberger's loop prompt** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> The blog's loop wakes on an interval, triages repos, assigns the highest-value bounded task per repo, and requires hard gates (tests, live proof, green CI) before anything lands. This designs that loop for akm specifically — including akm's own hard-won gates.

## Prompt

```text
Design (do not yet run) a standing maintenance loop for the akm repo, adapting the
Steinberger loop to akm's specific gates and hazards. The loop should be runnable
via the /loop skill or a scheduled agent.

1. Define the triage inputs the loop reads each cycle: open GitHub issues/PRs, the
   akm proposal backlog (age + count), failing/flaky CI signals, state.db growth,
   docs marked stale by review 14, findings from the other reviews in this set, and
   the open follow-ups already tracked in MEMORY.md.

2. Define task selection: one highest-value BOUNDED task per cycle, within a strict
   permission envelope. Encode akm's non-negotiables as HARD GATES that must be true
   before any change lands:
   - Full `bun run check` green: 0 errors, 0 warnings, 0 test failures (the clean-
     commit rule — no exceptions without explicit human approval).
   - Tests run via the process-parallelism script (never TEST_PARALLEL>1; the epoll
     race is real).
   - Net-negative or neutral LOC bias; a change that only adds machinery is rejected
     pending owner review.
   - NEVER run improve/recombine/extract/consolidate against live data, and NEVER
     delete user data without per-path owner approval (both are absolute).
   - Effective config verified, not code defaults.

3. Define escalation: what the loop must NOT decide autonomously — irreversible
   deletes, config changes, releases, security-sensitive changes, and anything that
   would touch the live stash. These get queued for the owner, not executed.

4. Define stop conditions: stop when every triaged item is landed, decision-ready,
   blocked, or has no available work — do not spin. Define the wake cadence and
   argue it against cost (cache-window reasoning: short polls only for external
   state, long fallback otherwise).

5. Output: findings/15-maintenance-loop.md — the loop specification (triage inputs,
   selection rule, hard gates, escalation list, stop conditions, cadence) plus the
   exact /loop or scheduled-agent invocation to start it. Design only; the owner
   decides when to arm it.

Guardrails: this pass PRODUCES the loop design; it does not start the loop or make
any change. Every gate above is a constraint on the future loop, and on this pass too.

ultracode
```

## Refs

Stash:

- `memory:akm-release-gate-run-full-check` and `memory:zero-tolerance-failing-tests` (see MEMORY.md) — the CI/clean-commit gates the loop must enforce.
- `memory:akm-bun-parallel-test-hang` (see MEMORY.md) — why the loop must use the process-parallelism test script, never TEST_PARALLEL>1.
- `memory:feedback-no-unrequested-prod-data-runs` and `memory:feedback-subtract-dont-accrete-machinery` (see MEMORY.md) — the two behavioral gates (no live runs, net-negative bias).
- `memory:workflow-isclean-trust-reviewer` (see MEMORY.md) — gate "done" on the green gate + reviewer verdict, not agents' self-reports.

Repo:

- `docs/technical/testing-workflow.md` and `scripts/test-unit.sh` — the exact test invocation the gate must call.
- `docs/technical/manual-testing-checklist.md` — the live-proof checklist the loop's "live proof" gate draws from.
- `docs/roadmap.md` and the GitHub issue tracker — the triage input for task selection.
- The other files in this review set (`01`–`14`) — their `findings/` outputs become recurring triage inputs for the loop.
- `~/.claude/CLAUDE.md` — the non-negotiable delete + clean-commit + subtract rules the loop must hard-enforce.
