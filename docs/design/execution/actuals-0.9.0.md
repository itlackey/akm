# 0.9.0 bundle-adapter refactor — §12.1 actuals publication

Published 2026-07-21 at the refactor close (DoD item 8). Per plan §1.3 and
§12.1, net-LOC is **reported, never a gate** — the hard gates were the
zero-count greps, the per-chunk ledgers, and the parity/contract/behavior
tests, all of which are green at HEAD (see the chunk-8/chunk-10 ledgers and
the close-out audit).

## Whole-PR actuals (authoritative)

Method: two-tree `git diff --numstat` of the refactor branch HEAD against the
PR's merge target `main` @ `f7b95295` (main unchanged since 2026-07-13; the
working clone is shallow, so a merge-base walk is unavailable — the two-tree
diff is exact for the PR as it will merge).

| Scope | +ins | −del | net | files |
|---|---|---|---|---|
| `src/` | +32,074 | −25,032 | **+7,042** | 360 |
| `scripts/` | +2,105 | −176 | +1,929 | 39 |
| `tests/` | +33,300 | −35,242 | −1,942 | 725 |
| `docs/` | +17,047 | −538 | +16,509 | 97 |
| `schemas/` | +2,956 | −14,890 | −11,934 | 1 |
| **TOTAL** | **+89,087** | **−75,814** | **+13,273** | 1,234 |

## The projection miss, reported plainly

Plan §12.1 projected **src net ≈ −11,100 to −13,700**. Actual src net is
**+7,042** — a miss of ~18–21k lines. The ledger-recorded drivers:

1. **The frozen migrator home is a relocation, not a deletion.** The plan's
   deletion arithmetic counted the legacy taxonomy/grammar/layout surface as
   removed; the shipped design (ref-grammar decision §6, chunk-8) *copies* it
   verbatim into `src/migrate/legacy*` (`legacy-layout.ts`,
   `legacy-ref-grammar.ts`, frozen workflow-migration bodies, the cutover
   module) so the one-time journaled migration works forever against old
   state. Several thousand lines of "deleted" code therefore still exist,
   `@removeIn 0.10.0`.
2. **Chunk 5 landed net +5,291 vs a ~−480 target** (54 commits; see its
   retroactive ledger): the db.ts repository split scaffolding, the
   transitional dual-grammar machinery (later deleted, but its replacement
   resolver/provenance surface stayed), and a +632-line codemod script.
3. **Chunk 9 landed net +1,995 vs ~−2,000** (its ledger, self-reported): the
   taxonomy deletions it projected were re-owned by chunk 3, and the
   config-schema monolith was retained rather than replaced.
4. **Budgeted adds landed; budgeted deletions partially didn't.** The
   activation policy (+238, in budget) and adapters/RunContext/repositories
   landed as planned refactors-of-existing-coupling; but several plan-named
   deletions/consolidations never landed at all (next section), so their
   negative contributions never materialized.
5. **New machinery added post-plan by necessity:** the journaled cutover +
   backup manifest v3 + property harnesses (chunk 8), the bundle CLI read
   family (chunk 10), and the shipped-assets/goldens/fn-size/cycle lint
   gates under `scripts/` (+1,929).

`schemas/` net −11,934 is real contraction (the monolithic published schema
shrank with the discriminated-schema work and again with the #37 key
retirement). `tests/` net −1,942 despite ~+33k of churn reflects the
suite-wide re-pinning to the new contract.

## Per-chunk actuals (where attributable)

Figures are each ledger's own record; the four retroactive ledgers
(chunks 3/4/5/6.5) were adversarially verified 2026-07-21.

| Chunk | Net (scope as recorded) | Source |
|---|---|---|
| 0a | capture-only (goldens/briefs) | chunk-0a report |
| 3 | −191 src (5 commits) vs ~−1000 target | retroactive ledger, verified |
| 4 | −1,515 (8 commits) | retroactive ledger, verified |
| 5 | +5,291 (54 commits) vs ~−480 target | retroactive ledger, rewritten under verification, totals re-verified |
| 6 | +210 src vs ~−800 | chunk-6 ledger §12.1 line |
| 6.5 | +238 (budgeted +200..400) | retroactive ledger, verified |
| 9 | +1,995 vs ~−2,000 | chunk-9 ledger (self-reported) |
| 0b/1/1.5/2/7/8/10 | recorded per-WI in their ledgers; no single per-chunk §12.1 roll-up line was consistently kept | respective ledgers |

## Plan-named work that NEVER landed (deviations, dispositioned)

Recorded here so the §12.1 publication is complete; ownership tracking lives
in the close-out task list:

- `jsonColumn()` helper — never landed under any name (`git log -S` empty).
- `item_links` table + consumers — never landed (a §1.3 *budgeted add*).
- L0/L1/L2 progressive-disclosure artifacts (normative §15.2) — never landed
  (also §1.3-budgeted).
- Scored/enumerate filter-path unification (plan §4.3) — never landed; the
  two chains remain pinned separate by the scored-vs-enumerate golden.
- The 9-per-type-linter → adapter `validate()` consolidation (plan §12,
  −250 target) — never attempted; `a0c3ee02` kept the linters because
  `akmLint --fix` is live and the frozen lint golden pins their dispatch.
- DoD-5's three-verb naming (`revise`/`learn`) — the decomposition half
  shipped (chunk 7); the naming half: USER RULING 2026-07-21 — deferred to
  0.9.1 as a recorded deviation (alongside `item_links`, L0/L1/L2, and
  `jsonColumn`, same ruling; §13.2 prove-or-delete, Tier B, and the memory
  lifecycle model also confirmed 0.9.1+). The same ruling ordered the Group-A
  unlanded deletions/consolidations, the Group-C residue, and the 8
  format-family adapters ADDRESSED ON THIS BRANCH before merge — tracked as
  close-out tasks #45/#46/#47.
- The 8 spec'd non-akm format-family adapters — deliberately pivoted out
  (chunk-2 ledger); goldens retained as specifications.

## Ledger-record correction

The manifest's hard gate #4 ("every chunk commits its per-chunk deletion
ledger") was violated for chunks 3/4/5/6.5 during execution and repaired
2026-07-21 with adversarially-verified retroactive ledgers. The verification
itself caught and corrected: a missed chunk-3 commit, a chunk-4 D-R6
misattribution, and a chunk-5 draft that had captured 11 of 54 commits and
mis-narrated the flip stages — the corrected ledgers are the authoritative
record.
