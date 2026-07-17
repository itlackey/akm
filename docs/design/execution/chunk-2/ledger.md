# Chunk 2 — execution ledger (append-only)

Per-format adapters (10 adapters, 14 formats). Central Wave-2 chunk; purely
additive (globals stay until Chunk 3). Branch:
`claude/akm-architecture-refactor-fubvd7`.

## Opened — grounding census + brief

- `anchors.md`: the 10-adapter split (§A, a proposal for sign-off — parity-
  preserving, NOT the spec §4 aspirational okf registry), per-adapter porting
  anchors (§B recognize/placeNew/directoryList/validate/presentation), the
  special cases (§C skill Agent Skills, env/secret redaction, workflow two-form,
  the 9 metadata contributors), conformance mechanics (§D), parity vs the Chunk
  0b goldens (§E), registration + cycle (§F), 8 findings + proposed WI split.
- `brief.md`: WI-2.1..2.6, decisions D2-1..7, cycle-safety watch, 7-item traps.

### Decisions recorded (MAINTAINER REVIEW — made autonomously overnight)
- D2-1 the 10-adapter split (transitional parity-preserving: skill/wiki/script/
  workflow/task/dotenv[env+secret]/knowledge/agent-tooling[command+agent]/
  memory/note[lesson+session+fact]) — NOT the spec §4 okf registry (would break
  parity). Flagged for sign-off.
- D2-2 new core/adapter/registry.ts (asset-registry-modeled; additive).
- D2-3 validate() required but behavior-preserving (no new validation where none
  exists today; the reachability gap is preserved).
- D2-4 redaction port = renderer field-omission only, NOT core/redaction.ts.
- D2-5 skill Agent Skills contract (§4.5) = new feature, isolated WI-2.5, flag
  behavior changes.
- D2-6 per-adapter looksLikeRoot + new single-adapter golden-root fixtures.
- D2-7 the 9 index-time metadata contributors move into recognize.
