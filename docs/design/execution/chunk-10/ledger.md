# Chunk 10 — execution ledger

Status: CLOSED (2026-07-20). CI fully green at e822d09e — check (lint+tsc+unit+integration,
sharded, slow-inclusive) + node-smoke (22, 24) + smoke + actionlint. Chunk: "Contract-surface + docs/assets sweep"
(manifest id 10, plan §16/§7.3, D28, normative §29). Executed as a six-lane
Opus workflow (path-disjoint mandates) with orchestrator verification; two
lanes lost only their structured report emission (retry cap) — their tree work
landed intact and was verified by the orchestrator.

## Landed work (by lane)

| Lane | Landed | Headline |
|---|---|---|
| A governance | ✅ | STABILITY/AGENTS/roadmap ref-contract rewrite to `[bundle//]conceptId` + three-DB + bundles config; CHANGELOG normalized (`[Unreleased]`→`[0.9.0]`, old `[0.9.0]`→`[0.9.0-rc.1]`) with the one true 0.9.0 migration note; migration guide + release notes rewritten to the shipped story (EXPLICIT journaled `akm migrate apply`, not "automatic on first run" — lane correctly refused to contradict shipped behavior); README ref examples + asset-type table flipped, vault/wiki rows dropped |
| B docs sweep | ✅ | Teaching docs rewritten (ref.md, classification.md full rewrites; concepts 4→3 DB; install≠activate section); dead-grammar grep over owned docs 333 → 99, all 99 dated historical records (rewriting would falsify the record); 3 stale plans git-mv'd to docs/archive/ with banners, 0 broken inbound links |
| C assets | ✅ | cli-hints/help/akm-asset/stash-skeleton/example-stash/eval-probes migrated to the new grammar (+ matching conceptId parse in the judge-calibration runner); wiki type dropped from 5 improve-strategy JSONs (+ snapshot regen); NEW `scripts/lint-shipped-assets.ts` (§7.3 zero-tolerance gate) with three sanctioned carve-outs (ref-prefix search grammar, derived_from channel, meta:name); CLI-verified on a built binary; eval smoke green |
| D tooling | ✅ | scripts/ under biome+tsc verified; `check:changed` fixed (lint+tsc then 4 contract suites); `noExplicitAny` at error (3 documented suppressions remain, no laundering); `noUncheckedIndexedAccess` evaluated: ~1841 violations → left OFF, count recorded; schemas regenerated (no `bindings:` key), `schemas/**` removed from BOTH ci.yml paths-ignore blocks; shipped-assets lint wired into the lint chain |
| E bundle CLI | ✅ | `akm bundle list|show|items` (normative §29 READ family) over bundles/defaultBundle + §10.2 lock + index provenance; lifecycle verbs deliberately stay on existing commands; Tier B bind/unbind/bindings NOT implemented; registered in cli.ts + passthrough shapes; integration suite (25 tests) |
| F config retirement | ➡ | NEVER RAN (lane E's report-emission failure aborted the sequential thunk). Re-sequenced as the immediate next work item (task #37) — measured scope: setup persists `stashDir` throughout, `source-add` writes `sources[]`/`installed[]`, hundreds of test seeds use old shape; a focused pass, not a rider on this chunk's landing |

Fold-ins landed alongside (orchestrator, same tree): #39 `.stash.json` live-reader
retirement (user decision: drop sidecar metadata outright) and the chunk-8
ledger CLOSED stamp.

## Gate results (chunk close)

- `bun run lint` → 0 (now includes `lint-shipped-assets`; test-ref-literal ratchet holds at 50/50).
- `bunx tsc --noEmit` → 0. `bun scripts/gen-config-schema.ts --check` → 0 (byte-identical, no `bindings:`).
- Manifest gates: no shipped asset/hint/schema/normative doc teaches the dead grammar
  (survivors are dated historical records, enumerated in lane reports); schemas back in CI paths;
  §7.3 shipped-assets lint green; check:changed fixed; noExplicitAny at error.
- One post-lane fix by the orchestrator: `tests/contracts/migration-baseline.test.ts` pins the
  contiguous phrase "does not translate profile-based configuration" — lane A's rewrite wrapped it
  across a line break; doc rewrapped, contract green (content was preserved).
- Batteries at close: see the final verification note below.

## Deviations & dispositions

- Lanes C and E hit the StructuredOutput retry cap (their reports embedded XML-ish tags inside
  JSON strings). Tree work was complete and verified; reports were recovered from transcripts.
- Lane A deviation (CORRECT): the workflow brief said "automatic on first run" for the migration
  note; shipped chunk-8 behavior is an explicit journaled coordinator with fail-closed commands.
  The lane wrote the truth and flagged it.
- Historical-record policy (A+B, ratified here): pre-0.9.0 migration guides, release notes, dated
  ADRs/incident logs keep the grammar that was live when they were written; rewriting them would
  misrepresent what those versions shipped. The shipped-assets/docs gates exclude them explicitly.

## #39 fold-in fallout (sidecar-seeded test fixtures)

Retiring the `.stash.json` live readers broke 17 integration tests that used sidecars purely as a
SEEDING mechanism for controlled metadata on script assets (scoring/dedup/FTS mechanics suites).
Re-homed per the supported channels, assertion semantics preserved: bare-script seeds →
`knowledge/<name>.md` frontmatter (knowledge, like script, carries no type boost); the one
skill-with-native-home folded into its `SKILL.md`; the committed `ranking-baseline` fixture's
scripts + sidecars re-homed as knowledge with MANIFEST counts updated. All modified suites plus
every ranking-baseline consumer verified green; test-ref-literal ratchet holds 50/50.
Residue: `semantic-search-e2e.test.ts`'s `AKM_SEMANTIC_TESTS`-gated block still seeds sidecars —
those tests need real embeddings and cannot run here; they will need the same re-home when that
gate is next exercised.

## Verification note (orchestrator)

Personal verification pass: lane-by-lane diff review (bundle.ts full read; eval-runner parse
change; CHANGELOG version-identity rename eyeballed per lane A's flag), targeted suites
(bundle-command 25/0, default-improve-strategies snapshot green, migration-baseline contract
green after rewrap), then full sharded batteries (results recorded in the closing commit).
