# Ranking Ablation & Score-Saturation Analysis

> **Status:** Current-truth methodology reference (2026-07-05). Cite code by SYMBOL (files move).
> This document lets a future session **reproduce** the ranking-contributor ablation measurement,
> **extend** it, and **avoid the measurement traps** that make naive ablation read Δ=0. It also
> fully specifies two open investigations: **evaluating the sort-clamp change** (§7) and the
> **saturation-frequency audit** (§8).
>
> Companion (local-only / gitignored, holds the private-corpus numbers): the meta-review findings
> `E6-second-corpus-probe-design.md`, `E6-ranking-saturation-finding.md` (search the findings dir).

---

## 1. Why this exists

The ratified meta-review item **02 (contributor ablation)** asks: which of akm's ranking
contributors are load-bearing, and which are dead weight that could be deleted? The natural method —
remove a contributor, re-run a labeled query suite, look at the score delta — kept returning **Δ=0
for almost every contributor**, on both the in-repo `curate-golden` fixture (batch 2: 12/13 Δ=0)
and on purpose-built disjoint-domain fixtures (E6). That Δ=0 is **not** proof the contributors are
useless; it is an artifact of two structural properties of the ranking pipeline (§4). Measuring
contributor value — and therefore any ranking tuning — requires understanding those properties
first. Getting this wrong means tuning against a number that cannot move.

---

## 2. How akm ranking scores a result (the pipeline)

One scoring pipeline for all indexed content (CLAUDE.md / v1 spec §6 — no parallel scorer). For a
query, per candidate entry:

1. **Search surface** — `buildSearchFields` (`src/indexer/search/search-fields.ts`) builds the
   FTS/embedding text from **name, description, tags+aliases, hints (searchHints + examples + usage
   + `whenToUse`), and content (= TOC headings + param names/descriptions)**. **The markdown BODY
   prose is NOT included.** Ranking keys off structured metadata, not body text.
2. **Base score** — normalized BM25 (FTS5) + cosine similarity of the embedding, weighted-added
   (`normalizeFtsScores`, `combineSearchScores` in `src/indexer/search/ranking.ts`).
3. **Score contributors (additive→multiplicative)** — `applyScoreContributors`
   (`ranking-contributors.ts`) sums each applicable contributor's `adjust()` into `boostSum`, then
   `item.score *= 1 + Math.min(boostSum, MAX_BOOST_SUM)` (`MAX_BOOST_SUM = 3.0`). So contributors
   scale the base score; a negative sum (e.g. belief `contradicted` = −0.45) multiplies the score
   DOWN (`* 0.55`).
4. **Utility contributors** — `applyUtilityContributors` applies `utility-ranking` and
   `salience-ranking` (`defaultUtilityRankingContributors`) similarly.
5. **Derived-twin belief inheritance (03-R3)** — `inheritDerivedTwinBeliefStates` copies a base
   memory's demoting belief state onto its `.derived` twin before ranking, so the twin is demoted too.
6. **Display + sort** — `displayScore` (`src/indexer/search/db-search.ts`) =
   `round(clamp01(rawScore) * 1e4) / 1e4`, and the sort is **`displayScore` descending, then
   `name.localeCompare` as the tiebreak**.

### Contributor registry (`defaultRankingContributors` + `defaultUtilityRankingContributors`)

`exact-name-ranking`, `type-ranking`, `belief-state-ranking`, `tag-ranking`, `search-hint-ranking`,
`alias-ranking`, `description-ranking`, `metadata-ranking`, `graph-ranking`, `capture-mode-ranking`,
`lesson-strength-ranking`, `pinned-fact-ranking`, `project-context-ranking` (score list) +
`utility-ranking`, `salience-ranking` (utility list). Belief-state boosts (`beliefStateBoost`):
`contradicted −0.45`, `archived −0.6`, `superseded −0.25`, `deprecated −0.15`, `asserted +0.08`,
`active +0.06`.

---

## 3. The tooling

### 3.1 `curate-bench` — the labeled-query scorer

`scripts/akm-eval/bin/akm-eval-curate-bench` (thin wrapper over `scripts/akm-eval/src/curate-bench.ts`).
It seeds a fixture dir into a throwaway OS-tmp sandbox, indexes it with the **deterministic embedder**
(`AKM_EMBED_DETERMINISTIC=1` — no model, byte-stable across machines/versions), runs `akm curate` per
labeled query through the real CLI, and scores the RANK against judgments (nDCG / recall / MRR /
leapfrog gate — `src/core/eval/rank-metrics.ts`, `curate-metrics.ts`).

```
AKM_EMBED_DETERMINISTIC=1 bash scripts/akm-eval/bin/akm-eval-curate-bench \
  --fixture <corpus-dir> --format json \
  --akm "bun /abs/path/to/akm/src/cli.ts"     # test the SOURCE checkout (not the global)
  # optional: --compare "<other akm cmd>"  for an A→B per-case delta table
```

Because the embedding axis is frozen, any score delta between two `--akm` binaries (or between
ablations) is attributable to source/config, not model drift. **Always hold the embedder constant.**

Output shape: `{ akm, summary: { meanNdcg, meanRecall, meanMrr, totalBannedLeapfrog, meanNoBannedAboveRequired }, perCase: { <id>: { ndcg, recall, mrr, noBannedAboveRequired, bannedLeapfrogCount, score } } }`.

### 3.2 `AKM_ABLATE_CONTRIBUTORS` — the ablation flag (committed, eval-only)

`applyContributorAblation` (`ranking-contributors.ts`), wired into `applyRankingRules` (`ranking.ts`),
drops named contributors when the env var is set. **No-op (production ranking unaffected) when unset.**

```
# baseline (all contributors):
AKM_EMBED_DETERMINISTIC=1 bash .../akm-eval-curate-bench --fixture <dir> --akm "bun .../src/cli.ts" --format json
# with one contributor removed:
AKM_EMBED_DETERMINISTIC=1 AKM_ABLATE_CONTRIBUTORS=belief-state-ranking \
  bash .../akm-eval-curate-bench --fixture <dir> --akm "bun .../src/cli.ts" --format json
# multiple: AKM_ABLATE_CONTRIBUTORS="exact-name-ranking,type-ranking"
```

Names are the contributor `name` fields listed in §2. Unknown names are ignored; whitespace tolerated.

### 3.3 Building fixtures (curate-golden format)

A fixture is a directory of asset-type subdirs + a `judgments.json`. Model on
`tests/fixtures/stashes/curate-golden`. Directories: `knowledge/`, `skills/<name>/SKILL.md`,
`commands/`, `agents/`, `workflows/`, `scripts/`, `memories/`, **`lessons/`** (frontmatter MUST have
`description` AND `when_to_use` — enforced by `src/core/lesson-lint.ts`), **`facts/`** (frontmatter
`description` + `category` ∈ {personal, team, project, convention, meta} per `fact-linter.ts`).
Belief-state memories: frontmatter `beliefState: contradicted|superseded|deprecated|archived`
(+ `contradictedBy: ["memory:<ref>"]`); a derived twin is `<name>.derived.md`.

`judgments.json`: `{ schemaVersion:1, corpus, note, queries:[ { id, query, relevant:[refs],
idealOrder:[refs], banned:[refs], limit } ] }`. Refs are `type:name`. Labels are SEMANTIC ground
truth (what SHOULD rank), independent of what akm currently returns. `banned` = off-topic refs that
must never outrank a relevant ref (the leapfrog gate).

### 3.4 The E6 disjoint second corpus

`$HOME/akm-e6/fixtures/{culinary,medical,legal}/` — 3 hand-authored fixtures in the above format,
built to be **disjoint** from the owner's dev/agent stash (Bet-4 generalization probe). Bulk
knowledge corpora also live under `$HOME/akm-e6/corpus-*` (public repos: `Anduin2017/HowToCook`,
`philschatz/anatomy-book`, `philschatz/economics-book`). The entire E6 tree is a **sandbox**: every
`akm` call there uses a wrapper (`$HOME/akm-e6/e6-akm.sh`) that points `AKM_CONFIG_DIR /
AKM_DATA_DIR / AKM_CACHE_DIR` + the `XDG_*` mirrors at `$HOME/akm-e6/home`, so it never touches the
live install. **Reproduce isolation exactly** when extending — see `memories/akm-isolate-config-in-init-repros`.

---

## 4. The measurement trap (why naive ablation reads Δ=0)

Two structural facts, both code-verified:

1. **Body prose is not a ranking field** (§2.1). Constructing a distractor with a near-identical
   *body* does NOT create a near-tie — the body is invisible to ranking. Near-ties must be built via
   name/description/tags/hints/headings.
2. **The display clamp + quantize + name-tiebreak absorbs contributor deltas on saturation.** Once
   competing entries' raw scores both land ≥ 1.0 they clamp to `1.0000`, **tie**, and sort
   **alphabetically by name** — not by the contributor delta that distinguishes them. Since several
   contributors each scale the score substantially (exact-name, type, description), a top match
   saturates easily, and a smaller contributor's delta (pinned +0.15, belief `active` +0.06,
   metadata, capture-mode) is then invisible to rank order → ablating it reads Δ=0.

**Regime rule (internalize this):** a contributor's ablation delta is observable ONLY in the
**unsaturated regime** (competing raw scores near/below 1.0). In the saturated regime the ablation is
blind. This is why `curate-golden` and realistic E6 queries read Δ=0 for most contributors, and why
only `lesson-strength` was isolable on E6 (an author balanced overlap so neither side saturated).

**Consequence for 03/04 belief-state:** the `contradicted −0.45` penalty is robust when the
contradicted entry's raw score is below ~1.45 (after `*(1−0.45)` it drops below a competitor's
clamped 1.0). It is **silently defeated** when the contradicted entry is matched strongly enough to
stay ≥ 1.0 even after the penalty — then the alphabetical tiebreak decides whether contradicted info
outranks correct info. Frequency in production is unquantified → that is exactly what §8 measures.

---

## 5. Reproduce the results so far

- **Baselines** (deterministic embedder, `--akm "bun src/cli.ts"`): culinary meanNdcg 0.859 /
  medical 0.757 / legal 0.673. (`curate-bench --fixture $HOME/akm-e6/fixtures/<dom>`.)
- **Stack-level ablation is decisive** where per-contributor is not: ablating ALL score contributors
  on the legal fixture *raises* meanNdcg 0.673→0.723 — i.e. the tuned stack is mildly
  **counterproductive** on a disjoint corpus (first empirical Bet-4 overfit signal). Reproduce:
  `AKM_ABLATE_CONTRIBUTORS="<all 13 score-contributor names>"`.
- **Culinary per-contributor matrix** (13, individually): only `type-ranking` load-bearing
  (ΔmeanNdcg −0.018; ablating it drops the knife-skills query −0.37), `exact-name-ranking`
  counterproductive (+0.022, removes a leapfrog); the other 11 Δ=0 (the saturation trap).
- **Ablation matrix method:** for each contributor, run the bench with `AKM_ABLATE_CONTRIBUTORS=<name>`,
  diff `summary.meanNdcg` and `perCase[*].ndcg` vs baseline. **Sign convention:** ΔmeanNdcg **< 0**
  = ablating HURT = contributor is load-bearing; **> 0** = ablating HELPED = counterproductive here;
  **≈ 0** = not decisive on these queries (often the saturation trap, not true uselessness).
- A ready driver pattern loops the ~13 names × N fixtures; keep runs SEQUENTIAL (each re-indexes a
  sandbox) and budget ~60–90 s/run.

---

## 6. Measurement discipline during tuning (the rules)

1. **Hold the embedder constant** (`AKM_EMBED_DETERMINISTIC=1`) for every A/B, or you are measuring
   model noise, not your change.
2. **Do not trust display-order ablation for saturated queries** — Δ=0 there is a blind spot, not a
   verdict. Confirm whether a query is saturated before concluding a contributor is dead (§8 method).
3. **Prefer instrumenting raw pre-clamp scores + per-contributor attribution** over display order
   when the question is "does this contributor matter." Display order answers "does it change what the
   user sees," which is regime-limited by design.
4. **Separate stack-level from per-contributor** ablation. Stack-level (ALL off) is robust and the
   right instrument for the overfit/Bet-4 question; per-contributor is regime-limited.
5. **Use a disjoint second corpus (E6), not just curate-golden** — single-corpus tuning cannot detect
   overfit (Bet 4). A contributor that helps the owner's stash may hurt a disjoint one.
6. **Remember the caps and shape:** contributors are multiplicative (`score *= 1 + boostSum`),
   `boostSum` is capped at `MAX_BOOST_SUM = 3.0`, and body prose is not indexed.
7. **Cite by symbol, never line** (files move — 13-B4). Keep private-corpus counts in the gitignored
   findings, method + public-corpus numbers here.

---

## 7. Open investigation: evaluate the sort-clamp change

**Hypothesis.** The `displayScore` clamp + `name.localeCompare` tiebreak (§2.6, §4) is the root cause
that (a) makes per-contributor ablation blind in the saturated regime and (b) can silently defeat the
belief-state demotion penalty. Changing how results are SORTED (while keeping the clamp for DISPLAY)
would make contributor effects — including safety-relevant demotion — robust under saturation.

**Why the clamp exists (do not naively remove — the constraint to preserve).** `displayScore` sorts
on a quantized value specifically to fix **Issue #14**: the raw score carries ~15 significant digits
and utility-recency uses `Date.now()` / `last_used_at`, so two runs of the same query can differ at
the 6th decimal; sorting on the raw value lets that invisible epsilon flip order run-to-run, and the
intended `name` tiebreak never engages. The quantize-then-name-tiebreak makes order deterministic.
**Any change MUST preserve run-to-run order stability.**

**Candidate changes (evaluate, do not ship blind):**
- (a) **Sort on the raw pre-clamp score, keep `displayScore` for display only.** Simplest; but
  reintroduces the #14 epsilon-flip unless the raw score is first quantized to a precision coarse
  enough to swallow the `Date.now()` epsilon yet fine enough to preserve contributor deltas (the
  belief `*0.55` factor is ~0.45 of the score — far coarser than the epsilon, so a middle precision
  likely exists).
- (b) **Raise/remove only the SORT ceiling** (keep clamp01 for display): sort on
  `round(max(0,raw) * 1e4)/1e4` without the upper clamp, so deltas above 1.0 still order. Same #14
  quantization guard applies.
- (c) **Tiebreak on raw score, not name**, only when display scores tie: cheapest, but the #14
  epsilon then decides true-tie order run-to-run — likely regresses stability; probably rejected.

**How to A/B measure (the gate):**
1. **Ablation observability:** author (or reuse) a saturated belief-state case (a contradicted entry
   that stays ≥1.0 after the penalty) and confirm `AKM_ABLATE_CONTRIBUTORS=belief-state-ranking` now
   yields Δ≠0 (an induced leapfrog) — i.e. the penalty actually reorders post-change.
2. **No golden regression:** `curate-bench --compare` old-vs-new on `curate-golden` + all 3 E6
   fixtures; require meanNdcg non-decreasing (allow the intended belief-demotion improvements).
3. **#14 stability guard (MANDATORY):** run the SAME query N≥20 times in one process against a fixture
   with a deliberate raw-score tie and assert the result ORDER is identical every run. A new unit/
   integration test must encode this (extend the `db-search` / ranking suite). Ship only if stable.

**Acceptance:** belief-state (and other) demotion is observable/robust under saturation **AND**
run-to-run order is stable **AND** no curate-golden/E6 regression. Record the before/after numbers in
an appendix here.

---

## 8. Open investigation: saturation-frequency audit (read-only)

**Goal.** Quantify (a) how often real queries produce saturated results (≥2 entries at
`displayScore == 1.0000`), and (b) how often **belief-flagged** (contradicted/superseded) entries
saturate — i.e. how often the demotion penalty is masked in practice. This decides whether §7 is
worth doing and whether belief-state / small-delta contributors are genuine subtraction candidates.

**Query set.** Use `scripts/akm-eval/src/gen-real-query-suite.ts` — it mines `index.db` `usage_events`
into a suite of what users ACTUALLY searched (READ-ONLY; writes only suite case files + a manifest).
Regenerating it over time and comparing is itself a health signal.

**Read-only discipline (critical).** `akm curate` against the LIVE stash **writes `usage_events`** —
do NOT do that during an audit (it pollutes the very signal you measure, and violates the meta-review
read-only rule). Two clean options:
- **(preferred) Replicate scoring offline:** open `index.db` `?mode=ro`, pull candidates + fields per
  query, and run the scoring path (or a faithful reimplementation of `applyScoreContributors` +
  `displayScore`) to emit the RAW pre-clamp score per entry. Count saturations from that.
- **(alt) Instrument a debug raw-score emit** behind an env flag (e.g. reuse the ablation-style
  eval-only pattern) and run curate in the E6 SANDBOX or a read-only copy of the index — never the
  live writable stash.

**Metrics to record:**
- Fraction of queries whose top-`limit` contains ≥2 entries at `displayScore == 1.0000` (saturation
  rate).
- Among results that are belief-flagged `contradicted`/`superseded`, the fraction whose **raw** score
  is ≥ 1.0 after the penalty (i.e. penalty absorbed → demotion masked) vs < 1.0 (penalty effective).
- Distribution of raw pre-clamp top-score (how far above 1.0 the ceiling routinely sits — tells you
  how coarse a §7 sort-quantization can be).
- Per-contributor: fraction of queries where the contributor's `adjust()` fired but did NOT change
  final order because of saturation (the "inert in practice" rate → subtraction evidence).

**Interpretation.** High saturation + high masked-contradicted rate ⇒ (1) belief demotion is
frequently inert → §7 clamp fix is high priority and safety-relevant; (2) small-delta contributors
that are routinely order-inert are subtraction candidates (verify per contributor, don't bulk-cut).
Low saturation ⇒ the trap is mostly a fixture/eval artifact and the contributors work in practice;
02 can proceed with the unsaturated-regime caveat noted. Record findings in the gitignored
`E6-ranking-saturation-finding.md` (private counts) and summarize the verdict here.

---

## 9. Provenance

Verified by reading `buildSearchFields` (`search-fields.ts`), `applyScoreContributors` /
`applyUtilityContributors` / `beliefStateBoost` / `defaultRankingContributors` /
`defaultUtilityRankingContributors` / `applyContributorAblation` (`ranking-contributors.ts`),
`applyRankingRules` + `displayScore` + the `preFilter.sort` (`ranking.ts` / `db-search.ts`), and
`inheritDerivedTwinBeliefStates`. Empirically corroborated by the E6 fixtures + ablation runs
(lesson-strength DECISIVE = clean leapfrog when ablated; belief-state/exact-name/pinned-fact Δ=0 due
to saturation). Full run detail + private-corpus numbers: the gitignored E6 findings notes.
