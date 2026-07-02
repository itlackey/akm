# 11 — Decisions into policy: stop re-litigating akm's recurring calls

> Adapts **"Decisions into policy"** from `wiki:articles/raw/blog-prompts-to-run-when-fable-comes-back`.
> akm sessions (and its cron) remake the same judgment calls over and over. This review finds those, extracts the latent rule behind each, and encodes it where it belongs — CLAUDE.md, a lint, a config default, a memory, or a schema constraint — so it runs on autopilot.

## Prompt

```text
Find the decisions akm's development and operation re-litigate from scratch every
time, and turn each into a standing policy encoded in the right place.

1. Mine for recurring decisions across two layers:
   a. DEVELOPMENT decisions: patterns that recur in session logs, PR reviews, and
      the MEMORY.md index — e.g., "don't run improve/recombine on live data to
      check something", "verify effective config not code defaults", "unit vs.
      integration test placement", "subtract don't accrete machinery", "sandbox
      HOME/XDG for init repros". Many are already written as memories/CLAUDE.md
      rules — treat those as evidence the decision recurs, and check whether the
      encoding actually PREVENTS the mistake or just documents it after the fact.
   b. RUNTIME decisions akm itself remakes: which lane to run, whether to accept a
      proposal, salience thresholds, cooldowns — decisions currently made by
      per-run heuristics that could be standing config policy.

2. For each: state the latent rule in one sentence, then classify by reversibility ×
   stakes:
   - cheap + reversible but slow every time → automate/default it away.
   - expensive + irreversible but done recklessly → add a real gate (the destructive-
     delete rule is the canonical example — is it actually enforced, or just
     documented?).

3. For each rule, pick the RIGHT encoding and say why: CLAUDE.md instruction, an
   ESLint/custom-lint rule (enforced, not hoped-for), a config default, a schema
   constraint, a test/CI gate, or a memory. Flag rules currently encoded in a place
   that doesn't enforce them (a memory that describes a mistake the code still
   allows) and move them to an enforcing location.

4. Output: findings/11-decisions-into-policy.md — the recurring-decision table with
   latent rules, the reversibility×stakes sort, and the target encoding for each
   with the specific file to touch. Prefer one enforcing lint over three documenting
   memories.

Guardrails: read-only on live data; propose encodings, don't apply CLAUDE.md/config
edits this pass. Respect the non-negotiable delete rule as the worked example of a
policy that MUST be enforced, not merely documented.

ultracode
```

## Refs

Stash:

- `lesson:memory-akm-improve-salience-working-reference-lesson` — an example of a decision already promoted to a lesson; assess whether the promotion enforces anything.
- `memory:akm-improve-success-metric`, `memory:feedback-no-unrequested-prod-data-runs`, `memory:feedback-subtract-dont-accrete-machinery` (see MEMORY.md) — recurring decisions already captured as memories; test whether each is enforced or merely recorded.
- `memory:akm-release-gate-run-full-check` (see MEMORY.md) — a release-gate decision that should live in CI, not memory.

Repo:

- `docs/technical/akm-core-principles.md` — the principles that should already be policy.
- `docs/technical/functional-contract-patterns.md` — encodable patterns.
- `docs/technical/testing-workflow.md` and `docs/technical/test-coverage-guide.md` — the unit/integration decision that recurs.
- `~/.claude/CLAUDE.md` (the owner's global rules) — where several of these already live; check enforcement vs. documentation.
- The custom-lint / biome setup in the repo — the enforcement mechanism to route rules into.
