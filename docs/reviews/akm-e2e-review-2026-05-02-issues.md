# AKM End-to-End Review Issue List

Date: 2026-05-02

Derived from `docs/reviews/akm-e2e-review-2026-05-02.md`.

## Prioritization

- `P0` - breaks core discovery or first-run effectiveness
- `P1` - materially weakens trust, learning, or evaluation quality
- `P2` - contract drift or lower-risk follow-up work

## P0

### 1. Fix official registry compatibility with the live default index

Priority: `P0`

Why now:
The shipped default registry URL currently points to a live index format the runtime rejects, which breaks official registry discovery on the default path.

Primary evidence:
- `src/core/config.ts:302-307`
- `src/registry/providers/static-index.ts:250-264`
- live official registry URL currently returns `version: 2`

Suggested issue title:
`fix: restore compatibility between default official registry URL and parser`

Acceptance criteria:
- Default official registry search returns official hits without format warnings.
- Runtime supports the format served by the shipped default URL, or the default URL is updated to a compatible endpoint.
- A regression test covers the supported registry version contract.
- Release notes or docs explain the supported transition path if both versions are temporarily accepted.

### 2. Repair cold-start cache hydration for configured `sources[]`

Priority: `P0`

Why now:
Fresh git and website sources can be skipped because pre-index hydration still iterates the removed `stashes[]` path.

Primary evidence:
- `src/indexer/search-source.ts:256-279`
- `src/core/config.ts:540-545`

Suggested issue title:
`fix: hydrate cache-backed sources from sources[] on cold start`

Acceptance criteria:
- `ensureSourceCaches()` uses the supported `sources[]` runtime shape.
- Fresh-cache git and website sources are materialized before indexing.
- End-to-end tests cover empty-cache git and website source indexing.
- No supported config path relies on `stashes[]` anymore.

### 3. Define and enforce one canonical wiki contract

Priority: `P0`

Why now:
Wiki behavior currently disagrees across CLI hints, page listing, scoped search, and regeneration semantics, which makes the knowledge surface hard to trust.

Primary evidence:
- `src/output/cli-hints.ts:139-149`
- `src/wiki/wiki.ts:592-610`
- `src/wiki/wiki.ts:631-661`
- `src/indexer/indexer.ts:286-293`

Suggested issue title:
`design: align wiki raw/page/search/regeneration behavior to one contract`

Acceptance criteria:
- A single documented rule defines whether `raw/` is addressable, searchable, and listed by `wiki pages`.
- Implementation matches that rule in `wiki pages`, scoped wiki search, and stash-wide wiki indexing.
- Regeneration behavior for stash-owned vs external wikis is explicit and implemented consistently.
- Tests and CLI help reflect the same contract.

## P1

### 4. Add a non-exploratory benchmark lane to CI and narrow claim scope until it exists

Priority: `P1`

Why now:
The repo has a promising utility benchmark, but it remains manual and partly exploratory, so current effectiveness claims should stay narrow.

Primary evidence:
- `.github/workflows/ci.yml:1-86`
- `docs/technical/benchmark.md:1-19`
- `tests/bench/BENCH.md:39-50`

Suggested issue title:
`feat(bench): add CI-backed utility benchmark lane and claim-scope guardrails`

Acceptance criteria:
- CI runs at least one stable, non-exploratory benchmark path.
- The benchmark job has documented pass/fail rules.
- Public-facing docs state which benchmark outputs are exploratory vs decision-grade.
- Release notes avoid broad effectiveness claims unless backed by the non-exploratory lane.

### 5. Strengthen benchmark rigor for broad effectiveness claims

Priority: `P1`

Why now:
Even with a CI lane, the benchmark still needs stronger statistical and methodological grounding before it can support broad external claims.

Primary evidence:
- `docs/technical/benchmark.md:1-19`
- `tests/bench/BENCH.md:39-50`
- consensus review finding `F10`

Suggested issue title:
`enhance(bench): add reproducibility, statistics, and broader task coverage`

Acceptance criteria:
- Seed handling is either truly controlled or renamed to reflect repeated trials rather than deterministic seeds.
- Reports add uncertainty or reliability framing for key metrics.
- Corpus coverage expands beyond the current narrow task mix.
- `evolve` has explicit graduation criteria before being presented as decision-grade.

### 6. Preserve provider semantics under registry overrides and stop raw cross-provider score ordering

Priority: `P1`

Why now:
Registry results become less trustworthy when `AKM_REGISTRY_URL` strips provider metadata and merged hits are ordered by heterogeneous raw scores.

Primary evidence:
- `src/commands/registry-search.ts:111-126`
- `src/commands/registry-search.ts:86-91`

Suggested issue title:
`fix(registry): preserve provider metadata in overrides and normalize multi-provider ranking`

Acceptance criteria:
- Env-based registry overrides preserve or explicitly declare provider type.
- Non-static providers such as `skills-sh` continue to work under override paths.
- Merged cross-provider results are either normalized, partitioned, or clearly marked as not directly comparable.
- Tests cover both override semantics and multi-provider ordering behavior.

### 7. Unify asset history across usage and proposal lifecycle events

Priority: `P1`

Why now:
Operators and future automation need one coherent lifecycle view for usage, feedback, proposal promotion, and rejection.

Primary evidence:
- `src/commands/history.ts:1-8`
- `src/commands/proposal.ts:115-128`
- `src/commands/proposal.ts:169-178`

Suggested issue title:
`feat(history): surface proposal lifecycle alongside usage history`

Acceptance criteria:
- User-visible history can show both usage events and proposal lifecycle events for an asset.
- The command contract clearly explains event sources.
- At least one test covers a proposal accept/reject event appearing in the user-facing history path.

### 8. Tighten feedback telemetry, registry result counting, and negative-signal semantics

Priority: `P1`

Why now:
The learning loop works, but it is easier than it should be to undercount useful signals or weaken negative evidence.

Primary evidence:
- `src/commands/search.ts:197-215`
- consensus review finding `F8`

Suggested issue title:
`enhance(feedback): improve telemetry coverage and negative-signal handling`

Acceptance criteria:
- Registry-only searches record correct result counts.
- Docs state when reindexing is required for feedback-driven ranking updates.
- Negative feedback behavior is explicit in code and docs.
- Evaluation outputs make signal coverage visible enough to interpret learning results safely.

## P2

### 9. Remove or implement the empty-query search contract promise

Priority: `P2`

Why now:
The CLI contract currently says the query may be omitted to list assets, but runtime rejects an empty query.

Primary evidence:
- `src/cli.ts:214-244`

Suggested issue title:
`fix(search): align empty-query CLI contract with runtime behavior`

Acceptance criteria:
- Empty-query listing is either implemented end-to-end or removed from CLI/docs.
- Tests cover the intended behavior explicitly.

### 10. Keep search field documentation aligned with shaped output contracts

Priority: `P2`

Why now:
Docs correctly describe the detail levels in places, but the broader “local hits include ref” guidance can still be read more broadly than the default brief shape actually allows.

Primary evidence:
- `docs/cli.md:189-206`
- `src/output/shapes.ts:449-467`

Suggested issue title:
`docs(search): tighten ref/detail-level documentation against output shapes`

Acceptance criteria:
- Search docs describe `ref` availability by detail level without ambiguity.
- If possible, help text is generated from the same shape definitions or validated against them.

## Suggested execution order

1. Issue 1
2. Issue 2
3. Issue 3
4. Issue 4
5. Issue 6
6. Issue 7
7. Issue 8
8. Issue 5
9. Issue 9
10. Issue 10

## Notes

- Legacy benchmark methodology concerns were folded into the broader evaluation-rigor work instead of being tracked separately.
