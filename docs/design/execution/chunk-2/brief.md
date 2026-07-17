# Chunk 2 — Per-format adapters (implementation brief)

The central Wave-2 chunk: mint 10 real `BundleAdapter`s covering the 14 formats,
reproducing today's recognition/placement/renderer/lint behavior BYTE-FOR-BYTE
against the Chunk 0b parity goldens. Purely ADDITIVE — the globals (matchers.ts,
asset-registry.ts, LINTER_MAP, output/renderers.ts) stay the live path until
Chunk 3 repoints consumers. netLoc ≈ net-zero-to-negative. Authority: manifest
chunk id "2" (3 gates), adapter spec §§1–7, plan §4.5/§12.3, and
**`docs/design/execution/chunk-2/anchors.md`** (the census — per-adapter porting
anchors in §B; trust it over the spec's aspirational §4 registry).

## Binding decisions (Opus, autonomous overnight — MAINTAINER: review, esp. D2-1)

- **D2-1 — the 10-adapter split is the census's TRANSITIONAL parity-preserving
  grouping, NOT the spec §4 aspirational registry** (census §A — a decision for
  sign-off). The spec's `okf` adapter (pure frontmatter, no dir gate) would
  BREAK the parity gate against today's dir-hint goldens, so chunk 2 preserves
  dir-hint recognition. The 10 (types owned): `skill`(skill), `wiki`(wiki),
  `script`(script), `workflow`(workflow), `task`(task), `dotenv`(env+secret),
  `knowledge`(knowledge), `agent-tooling`(command+agent), `memory`(memory),
  `note`(lesson+session+fact). Rationale per grouping in §A.2. `wiki` is
  transitional (Chunk 4 replaces it with `llm-wiki`); pairings (dotenv,
  agent-tooling, note) are grounded in shared recognition/lint machinery.
- **D2-2 — adapter registry: new `src/core/adapter/registry.ts`** (census §F7),
  modeled on the asset-registry singleton (registerAdapter/getAdapters/
  adapterFor). ADDITIVE — adapters register here alongside the live globals;
  Chunk 3 repoints consumers off the globals onto this registry.
- **D2-3 — `validate()` is REQUIRED on every adapter, but BEHAVIOR-PRESERVING**
  (census §D/finding 4). For types with a dedicated linter, port it. For types
  with NO active linter today (script/secret/wiki/session — DefaultLinter or
  unreached), `validate()` reproduces the CURRENT result (DefaultLinter-clean /
  the type's actual current lint output) — do NOT add validation where none
  existed. The production-reachability gap is preserved, not closed (flag).
- **D2-4 — redaction port = the show-renderer FIELD-OMISSION only** (census §5/
  §C.2): port `envFileRenderer`/`secretFileRenderer`'s shape-level omission as
  the dotenv adapter's presentation, behavior-preserving. Do NOT pull in
  `core/redaction.ts`'s text-scrubbing (unrelated; would be new trust machinery,
  forbidden by §1.3).
- **D2-5 — the Skill Agent Skills contract (§4.5) is NEW FEATURE work, isolated
  in WI-2.5** (census finding 2): no existing code validates SKILL.md name
  format/description length/compatibility/metadata. Implement per §4.5 as
  ADDITIVE validation, but flag any currently-valid skill the new contract would
  reject (behavior change — be conservative; surface for maintainer sign-off).
- **D2-6 — `looksLikeRoot` per-adapter predicate + new single-adapter
  golden-root fixtures** (census finding 3): no per-adapter analog exists;
  today's probes are coarse "any of 14 dirs" checks. Each adapter gets a
  predicate that fires on its own root and no sibling's; build the single-adapter
  root fixtures the gate needs (the combined all-types fixture is the wrong
  shape).
- **D2-7 — the 9 index-time metadata contributors move INTO recognize** (scope):
  each type's `applyXMetadata` contributor (output/renderers.ts) folds into its
  adapter's `recognize` so the returned IndexDocument matches the recognition
  golden (which already includes the contributor output). Behavior-preserving.
  **REFINED by WI-2.1:** fold in ONLY contributors whose output has a carriable
  `IndexDocument` field AND that the recognition golden actually pins. `toc-metadata`
  (no `IndexDocument` TOC field) and `script-comment-metadata` (cycle-adjacent
  `indexer/passes/metadata.ts` home) were correctly NOT folded — the recognition
  golden pins only `{type, specificity, renderer, meta?}`, none of it contributor
  output. This bites for real in WI-2.4 (memory/note frontmatter contributors ARE
  carriable). Don't add an `IndexDocument` field or a cycle edge just to fold.
- **D2-8 — ROOT CONVENTION (set by WI-2.1, binding for all remaining WIs +
  Chunk 3).** A component's `c.root` (what `scanComponent` walks; what
  `recognize`/`placeNew` resolve relative paths against) = **the type's own stash
  SUBDIRECTORY** (skill component roots at `<stash>/skills`, not `<stash>`) — one
  adapter per root, no per-file competition. `directoryList()`/`looksLikeRoot(root)`
  instead operate at the **stash-root** granularity (install probe + git-stash
  pathspecs are repo-root-relative): they name/probe the stash-relative subdir names
  (`["skills"]`, `exists(root/skills)`). directoryList = "the stash subdirs that
  become component roots when mounted" — NOT "dirs relative to c.root." Two roots by
  design; do not "reconcile" them. Consequence: positional (not identity) recognition
  for dir-scoped types (see wiki) — faithful under the subdir mount, flagged for
  maintainer in the ledger. Every remaining adapter: `recognize`/`placeNew` treat
  `c.root` as the type subdir; `directoryList` returns stash-relative subdir names;
  `looksLikeRoot(root)` probes `root/<subdir>`.

## Cycle-safety watch (census finding 8 — ratchet at 18, zero-tolerance)
Adapters need new outward edges from `src/core/adapter/` into workflows/parser,
lint/env-key-rules, commands/env/env, the linters, etc. Each WI VERIFIES the
ratchet stays 18. If an adapter importing a cycle-participant would add a 19th
participant, copy the needed pure logic to a leaf or invert — do NOT launder via
dynamic import. Report the cycle count every WI.

## Work items (each: mint adapter(s) + parity test vs the Chunk 0b golden subset for its types; gate-green; additive)

- **WI-2.1 — registry + skill/wiki/script adapters.** Establish
  `core/adapter/registry.ts` + the pattern. Mint the 3 own-recognition adapters
  (skill without the §4.5 contract yet — that's WI-2.5). Each reproduces
  recognize (matchers §B)/placeNew/directoryList/validate/presentation +
  looksLikeRoot; parity-tested against recognition/placement/renderer/lint
  goldens for skill/wiki/script.
- **WI-2.2 — workflow + task adapters.** workflow's dual-form recognition (md
  content-probe + yaml program) + 2 renderers + linter; task's yaml
  recognition/placement/linter.
- **WI-2.3 — dotenv adapter (env+secret) + redaction port** (D2-4). The paired
  dangerous-key validate (shared env-key-rules loop) + the field-omission
  presentation; parity vs the env/secret renderer goldens (gate 3).
- **WI-2.4 — markdown family: knowledge / agent-tooling(command+agent) / memory
  / note(lesson+session+fact).** The generic dir-hint+markdownSpec recognition +
  the coupled agent-tooling classifyBySmartMd disambiguation + memory's richer
  contributor + the note trio's thin validate. The bulk of the metadata
  contributors (D2-7) land here.
- **WI-2.5 — Skill Agent Skills contract (§4.5)** (D2-5, isolated new-feature).
  Add the §4.5 validation to the skill adapter; flag behavior changes.
- **WI-2.6 — conformance suite + golden replay + close.** §15.7 conformance:
  index()==fold(recognize) for any adapter overriding index(); per-adapter
  looksLikeRoot fires on its own golden root, no sibling's. Full replay of all
  14-format Chunk-0b goldens through the adapters. Full `bun run check` ONCE
  (gate CHECK_EXIT==0). Ledger + net-LOC + the D2 decisions.

## Trap list
1. **Parity is byte-for-byte** — each adapter's recognize/placeNew/renderer/lint
   output must MATCH the Chunk 0b golden for its type (captured from today's
   globals). Test each adapter against the golden subset; don't "improve"
   behavior.
2. **Additive only** — do NOT touch/delete the globals (matchers/asset-registry/
   LINTER_MAP/renderers); Chunk 3 does that. Adapters coexist.
3. **Two redactions** — port the renderer field-omission, NOT core/redaction.ts
   (D2-4).
4. **validate behavior-preserving** — don't add validation where none exists
   today (D2-3); §4.5 skill contract is the ONE intentional addition (D2-5,
   flagged).
5. **Cycle ratchet 18, zero-tolerance** — verify every WI; copy-to-leaf if
   needed (finding 8).
6. **agent-tooling recognition is coupled** — command/agent classifyBySmartMd
   branches probe overlapping frontmatter; port as one internal switch (§A.2).
7. Full check at close, gate on CHECK_EXIT==0 (the wrapper's exit masks it);
   the workflow-crash-windows §15 chaos test is flaky under load — confirm any
   integration fail in isolation before treating it as real.
