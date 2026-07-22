# AKM 0.9.0 — Ref-grammar decision + revised Chunk-5 flip plan

**Status:** DECIDED — binding for the Chunk-5 flip and Chunk 8. Amends the adapter spec
(`akm-0.9.0-bundle-adapter-spec.md` §1.3/§5.1) and the normative spec
(`akm-format-neutral-bundle-workspace-spec.md` §11.1) only where §"Spec amendments" below says so;
everything else in both documents stands.
**Date:** 2026-07-18. **Context:** PR #719, branch `claude/akm-architecture-refactor-fubvd7`
(Chunk 5 ~70% banked; the flip stalled six times on the test-codemod problem).
**Question:** one canonical ref grammar (`[bundle//]conceptId`) vs. multiple ref formats — and,
downstream of that, how the deferred Chunk-5 flip + script-only test codemod actually executes.

---

## 1. The decision in one paragraph

**Keep a single canonical grammar and a single stored spelling (Option A's end-state), and take
the workable half of Option B as the abstraction: refs are `parse → resolve → serialize`, and the
short (bundle-omitted) form is a first-class *accepted input* at every boundary — CLI, repository
lookups, and tests — resolved by a deterministic, behavior-preserving rule.** There is no second
grammar: the short form is the same production with the optional prefix omitted, not a different
format. `type:name` is not an accepted form anywhere after the flip (it survives only inside the
frozen `src/migrate/legacy/` copy). This dissolves the codemod problem — the measured blocker was
never the grammar, it was the assumption that tests must *spell the bundle*; they don't, because
resolution supplies it, exactly the way origin-less `type:name` refs already work today.

Full Option B (a plural-format ref abstraction with a `type:name` compatibility spelling) is
**rejected**: normative §11.4 prohibits a permanent dual-parser, §11.2 prohibits `type` in refs,
and the measured test suite shows the compatibility form buys nothing — only ~225 of the ~4,700
ref literals are origin-qualified; the rest are already short refs relying on resolution.

---

## 2. Sub-decisions (each binding)

### D-R1 — Grammar model: one grammar, resolver-first abstraction

```
ref := [ <bundle> "//" ] <concept-id> [ "#" <fragment> ]     (unchanged, §11.1)
```

The ref abstraction is three functions with a type-level distinction between *maybe-short* and
*resolved*:

- **parse** — pure syntax, no I/O, no workspace knowledge. Already built:
  `parseBundleRef` / `BUNDLE_REF_RE` (`src/core/asset/asset-ref.ts:258,205`). Returns
  `BundleRef { bundle?: string; conceptId; fragment? }`.
- **resolve** — `resolveRef(input: string | BundleRef, ctx: RefContext): ResolvedRef` where
  `ResolvedRef` is `BundleRef & { bundle: string }` (branded or structurally narrowed). `ctx`
  carries the resolution surface (see D-R4). This is the one new module the flip adds (small,
  pure over an injected bundle list + an index lookup callback).
- **serialize** — `bundleRefToString` (`asset-ref.ts:248`), unchanged. Serializing a
  `ResolvedRef` always emits the fully-qualified form.

**The core rule:** *only `ResolvedRef` crosses a storage boundary; only unresolved input crosses
an input boundary.* Repositories, state writers, and durable keys take/emit fully-qualified refs
exclusively; parsers and CLI/API entrypoints are the only place short forms exist. This is
§11.1's "short form is input sugar" made structural instead of conventional.

### D-R2 — conceptId spelling: the qualified `<stash-subdir>/<canonical-name>` form

This resolves the open recognize/placeNew spelling split documented at
`src/core/adapter/adapters/akm-adapter.ts:397-403` ("owned downstream (Chunk 3/5)" — i.e., here).

The `akm` adapter's conceptId is the **qualified form**: the placement stash-subdir followed by
the per-type canonical name — `knowledge/http-caching`, `skills/code-review`,
`scripts/db/migrate/run.sh`, `workflows/release`. Not the bare canonical name that `recognize()`
currently emits (`akm-adapter.ts:198,224`), and not the raw file path (a skill's id is
`skills/<dir>`, not `skills/<dir>/SKILL`; per normative §11.2 the adapter owns both stripping
directions, so "path within the bundle" means *the item's path as the adapter defines it* — a
directory-item's path is its directory).

Why qualified beats the banked bare-name spelling:

1. **It makes the codemod purely textual.** `type:name → stashDirFor(type)/name` is a static
   13-row table (`asset-placement.ts:89-165`: skill→skills, command→commands, agent→agents,
   knowledge→knowledge, workflow→workflows, script→scripts, memory→memories, env→env,
   secret→secrets, lesson→lessons, task→tasks, session→sessions, fact→facts). No runtime helper,
   no semantic transform — the script-only gate holds.
2. **No cross-type identity collisions.** Bare names make `skill:deploy` and `workflow:deploy`
   both `bundle//deploy` — a behavior change (today's `entry_key = stashDir:type:name` keeps them
   distinct) and an unfixable ambiguity for the ~4,700 test literals. Qualified ids keep them
   distinct (`skills/deploy` vs `workflows/deploy`) with zero new machinery.
3. **It is the spelling `placeNew` already consumes** (`akm-adapter.ts:405`) and the spelling the
   adapter spec's §1.3 examples already show (`personal//knowledge/http-caching`,
   `team-catalog//workflows/release`). Only `recognize()` and the additive `item_ref` writer
   disagree, and both are one-line derivations.
4. **It preserves §11.2's reclassification invariant** far better than bare names: the qualified
   id is anchored on where the file *is*; a bare canonical name depends on per-type ext-keep/strip
   rules and can change when only the `type` changes.

**Search surfaces do not move.** `entry.name` / the FTS `name` column keep the *bare* canonical
name exactly as today (identity ≠ search text); `bm25(entries_fts,0,10,5,3,2,1)` and the §12.3
goldens are untouched by construction. Only `IndexDocument.conceptId` / `ref` / `item_ref` change
spelling.

Cost: the two banked derivation sites change (`akm-adapter.ts` recognize; `indexer.ts:1032`
`itemRef = ${bundle}//${entry.name}` → the qualified spelling) and the shadow-parity harness +
byte-identity proof re-run. The harness exists and is exactly the tool for this — that proof is
an afternoon, not a redesign. This is the *only* piece of banked Chunk-5 work this decision
revises.

### D-R3 — Canonical storage-key rule and accepted input forms

| Surface | Accepted form(s) | Stored/emitted form |
|---|---|---|
| Index identity (`entries.item_ref`, UNIQUE post-flip) | — (writer-derived) | fully-qualified `bundle//conceptId` |
| Durable state keys (`usage_events.entry_ref`, utility, feedback, proposal targets, `.derived-twin` bases) | — (derived from a resolved entry, never from raw input) | fully-qualified |
| Refs inside bundle content (frontmatter fields, workflow/task target refs) | short or fully-qualified | resolved against the **containing** bundle at index/parse time; stored fully-qualified |
| Prose body-refs (lint missing-ref scan, `akm mv` xref rewrite, search ref-prefix) | fully-qualified anchored form ONLY (`BUNDLE_REF_RE`); bare short tokens in prose are not refs | n/a (recognition, not storage) |
| CLI args / programmatic API / **tests** | short or fully-qualified (+ `#fragment`) | resolved per D-R4 before any lookup or write |
| `type:name` (old grammar) | **nowhere** after the flip; frozen migrator only | migrated once per §11.4 |

Unchanged from normative §11.1 except one amendment (D-R4's fallback order). The
"three legacy spellings per ref" probing that §11.1 calls out as the cost of leaving this open
(`rekeyStateDbForMove`) is exactly what this table retires.

### D-R4 — Resolution rule for short input refs (the §11.1 amendment)

§11.1 currently says CLI sugar resolves "against the workspace `defaultBundle`" — full stop. That
is a silent behavior regression: today an origin-less ref searches **all** sources in priority
order (`asset-ref.ts:22` — "primary → search paths → installed"), and 182 test files plus real
CLI muscle memory depend on it. Amended rule:

> A short ref from CLI/API input resolves to the **defaultBundle** if the conceptId exists there,
> otherwise to the first bundle containing the conceptId in **installation priority order**
> (the `deriveInstallations` / config order — the same order origin-less lookups walk today).
> First match wins, deterministically. No match → not-found error naming the forms tried.

Content-internal short refs resolve to the **containing** bundle, never defaultBundle (unchanged,
§11.1). The old `local//` scoping (primary-only) is replaced by an explicit
`resolveRef(input, { only: bundleId })` API option, not a ref spelling. A later lint MAY warn
when a short ref shadows the same conceptId in a lower-priority bundle; it is not a 0.9.0 gate.

### D-R5 — Bundle identity (the Chunk-8 coupling, pinned now)

A bundle id is a **workspace-assigned slug** (charset per §11.1: no `/ : . #` or whitespace),
chosen by this precedence:

1. **Config key** — the key in the Chunk-8 `bundles` map. Authoritative once Chunk 8 lands.
2. **`registryId`** — for registry-installed sources (today's behavior, `installations.ts:115`).
3. **`slugForPath(sourcePath)`** — basename slug, batch-unique via path-hash suffix
   (`installations.ts:73,147`) — the fallback for unconfigured ad-hoc sources only.

Stability semantics:

- The id is **workspace-scoped and stable under path moves once configured**: Chunk 8's config
  migration writes the `bundles` map keyed by exactly what rule 2/3 derives today
  (`registryId ?? slugForPath(path)`), so **no second identity migration happens at Chunk 8** —
  the §11.4 `type:name → conceptId` re-key is the only one. After migration, editing a bundle's
  `path` doesn't change its key; changing the key is `akm bundle rename` (§11.5 rekey
  transaction, with the §11.5 startup guard against silently re-minted state).
- `defaultBundle` = the primary stash's derived id, emitted by the migrator.
- **mkdtemp instability is confined and irrelevant**: an unconfigured tmp-dir fixture gets a
  random slug, but under D-R1/D-R4 tests never need to spell it — they speak short refs. The few
  tests that assert fully-qualified *stored* keys pin identity explicitly (set `registryId`, or
  mount the source at a fixed-basename child of the tmp dir); that is the hand-edit bucket, not
  the codemod.

---

## 3. Why this dissolves the forcing problem

The stall analysis framed the choice as (a) inject runtime `bundleFor(dir)` helpers into 182 test
files (semantic transform — violates the script-only gate) or (b) use the short form for
content-internal refs only. Both assume API boundaries demand fully-qualified refs. They don't —
and never did in the old grammar either: `AssetRef.origin` is optional, `findEntryIdByRef` takes
an optional `stashDir`, and the suite's literals are overwhelmingly origin-less
(~4,700 total, ~225 origin-qualified, 8 files setting `registryId`). **Today's tests already
exercise a resolve-at-lookup model.** Making short-form resolution first-class in the new grammar
(D-R1/D-R4) means the codemod maps short ref → short ref:

```
"skill:code-review"          → "skills/code-review"           (static table, D-R2)
"script:db/migrate/run.sh"   → "scripts/db/migrate/run.sh"
"knowledge:guide.md"         → "knowledge/guide"              (markdown ext-strip, same table)
"npm:@scope/pkg//skill:x"    → hand bucket if asserted as a stored key; else registryId is the
                                bundle id and the mapping is textual (D-R5 rule 2)
"local//skill:x"             → hand bucket (scoped-resolve API or fixture registryId), ~subset of 225
```

No literal ever needs the random `akm-<hash>` slug. The codemod is a table-driven regex over
`.ts` + JSON fixtures — squarely inside the plan §15 rule-2 "script-only, zero hand-edited
hunks, ≥20-literal mutation spot-check" gate.

**Why not full Option B anyway?** A retained `type:name` parser is (1) prohibited as a permanent
dual-parser (§11.4), (2) reintroduces `type` into identity against §11.2 and D28, (3) keeps ~216
src parse sites alive that the flip exists to delete, and (4) solves only the same problem the
resolver already solves. Multiple *stored* spellings are strictly worse: every reader grows
N-way probing (the `rekeyStateDbForMove` disease §11.1 already diagnoses), and durable-state
survival across rebuilds (usage_events relink, derived-twin base lookup) would need spelling
normalization at every join forever.

---

## 4. Revised Chunk-5 flip execution plan

Every step lands green on the integration branch; the dual-input window opens at F1 and closes at
F5 **inside the same chunk**, satisfying §11.4's no-permanent-dual-parser rule. Chunk-8 scope
(three-DB merge, config migration, journaled cutover) is untouched.

- **F0 — Pin the conceptId spelling (additive, ~2 sites).** Change `recognize()`'s conceptId and
  the `item_ref` writer (`indexer.ts:1032`) to the D-R2 qualified form; `entry.name`/FTS
  untouched. Re-run the shadow-parity harness (`tests/integration/shadow-scan-parity.test.ts`)
  and the byte-identity proof for the `item_ref` derivation; delete the spelling-tension NOTE at
  `akm-adapter.ts:397`. Gate: parity green, §12.3 suites green (they must be unaffected — FTS
  inputs unchanged).
- **F1 — Resolution layer + dual-input readers repointed onto `item_ref`.** Add
  `resolveRef`/`RefContext`/`ResolvedRef` (D-R1, D-R4). Repoint the seven readers
  (`index-entries-repository.ts:41,178,245,386,534,727,755`) to key on `item_ref`, accepting
  BOTH grammars at the input edge (old `type:name` translated via the static D-R2 table +
  source→bundle map; new refs resolved via D-R4). `getEntryByRef(db, type, name)` gains a
  ref-shaped overload; `.derived-twin` suffix logic moves to conceptId-suffix on `item_ref`.
  Additive; the whole existing suite stays green on the old literals. Gate: full suite green
  pre-codemod; readers' old-grammar path is a thin shim marked for F5 deletion.
- **F2 — The script-only codemod (the ~4,700 literals, ~150+ files).** One script in `scripts/`:
  the D-R2 static table over quoted/template `[origin//]type:name` literals in `tests/**` (.ts +
  fixture JSON), per-type name normalization (markdown `±.md`), `registryId` origins carried as
  bundle ids, `DESIGNATIONS.json` path/hash regeneration. Lands atomically with nothing else in
  the commit. Gate: suite green behind the F1 dual readers; mutation spot-check — revert ≥20
  random re-keyed literals, suite must go red, recorded in the chunk ledger; grep ratchet arms
  `type-prefix literal in tests/` → shrink-only.
- **F3 — The hand bucket (separate, individually reviewable commits; ~40–60 files as already
  ledgered in plan §12.1).** parseAssetRef unit tests ported to parseBundleRef/resolveRef;
  `local//` scoping tests → `{only}` resolution option; tests asserting stored-key spellings pin
  bundle identity via `registryId` or fixed-basename fixture roots; goldens re-baselined where
  the *asserted key* (not ranking) changed.
- **F4 — The flip proper.** Swap the live scan loop: `generateMetadataFlat` (`indexer.ts:873`) →
  `scanComponent` (`scan-component.ts:136`) over `deriveInstallations`; `StashEntry` →
  `IndexDocument` rename; `entry_key/stash_dir/entry_type` demoted, `item_ref` becomes THE key
  with the UNIQUE constraint (`index-schema.ts:242` note); diff persistence per plan; the
  shadow-parity harness flips to assert the **persisted index** against the legacy stream one
  last time, then the legacy stream is deleted. Index-db-resident state (`usage_events`,
  utility/feedback) re-keys onto `item_ref` via the §11.4 join-against-last-good-index mapping
  with orphan quarantine. `REF_RE` at `base-linter.ts:182` retargets to `BUNDLE_REF_RE`. Gate:
  §12.3 full parity (nDCG/MRR/recall + filter + whyMatched), durable-state survival suite
  (relink across full rebuild, derived-twin base lookup, content-hash skip), fn-size + cycle
  ratchets (db trio leaves the baseline per DoD 11).
- **F5 — Delete the old grammar.** `parseAssetRef`/`makeAssetRef`/`refToString`/`AssetRef`/
  `TYPE_ALIASES` deleted (~216 sites already repointed by F1/F4); the F1 old-grammar reader shim
  deleted; frozen `src/migrate/legacy/legacy-layout.ts` untouched. Gate: grep `parseAssetRef` →
  0, `StashEntry` → 0 (declared scopes); tests type-prefix ratchet → 0 and flipped absolute.

**Chunk 8 then consumes D-R5 as settled:** the config migrator emits `bundles` keys equal to the
already-derived ids (no re-key), `defaultBundle`, the §11.5 startup guard, and the three-DB
merge re-key runs over refs that are already in final spelling.

### D-R6 — OKF reserved filenames: `index.md` / `log.md` are structure, never items (BINDING)

Verified against upstream OKF v0.1 §3.1/§6/§7 (2026-07-19 audit): `index.md` (directory listing,
progressive disclosure) and `log.md` (update history) are **reserved structural files at every
level of a bundle** and "MUST NOT be used for concept documents." AKM's OKF-compliant behavior:

1. **Never indexed as items.** No adapter may emit an `IndexDocument` for a reserved filename.
   The `okf` and `llm-wiki` adapters already comply (`okf-adapter.ts` `RESERVED_FILES`,
   case-insensitive, any depth). The **`akm` adapter does not yet** — a `knowledge/index.md`
   would today classify as a `knowledge` concept. Its recognition exclusion is a behavior
   change and lands with the flip (F4) / Chunk-8 producer-conformance migration, which also
   handles any existing stash file named `index.md`/`log.md` (exclude from the index; rename
   if its content is a real concept).
2. **Never touched as assets.** Reserved files are bundle structure, not items: `placeNew`,
   `akm mv`, and item write-transactions MUST refuse a reserved-filename target (they have no
   conceptId, so no ref can name them — the grammar enforces this passively; the write paths
   enforce it actively). Regenerating an `index.md` listing or appending to `log.md` is a
   *bundle-maintenance* operation owned by the bundle's adapter (e.g. llm-wiki's native log
   semantics), never an item write.
3. **Producer side (Chunk 8):** AKM-generated bundles emit `index.md`/`log.md` only in the §6/§7
   listing/log shapes; the only frontmatter ever emitted in an `index.md` is the optional
   bundle-root `okf_version` block (upstream §11).

## 5. Spec amendments (exhaustive)

1. Normative §11.1: CLI/API short-ref resolution — replace "resolved … against the workspace
   `defaultBundle`" with the D-R4 defaultBundle-then-priority-order rule.
2. Normative §7.8/§11.2 (clarifying note, no rule change): "path within the bundle" is the item's
   path *as the adapter defines it*; a directory-item's path is its directory (skills).
3. Adapter spec §5.1: pin the akm adapter's conceptId to the D-R2 qualified spelling; drop the
   recognize/place spelling-tension note.
4. Plan §11 Chunk 5: insert F0/F1 (spelling pin + resolver/dual-reader step) ahead of the codemod;
   codemod and grep gates otherwise unchanged.
5. Adapter spec §5.1/§6 (+ Chunk-8 checklist): the D-R6 reserved-filename rule — `index.md`/
   `log.md` are never recognized as items and never valid write targets; the akm adapter's
   exclusion + existing-file handling land with F4/Chunk 8.

## 6. Invariants check

- **FTS5 schema + bm25 weights unchanged** — D-R2 keeps `name`/search fields on the bare
  canonical name; identity-only change (spec line 245 holds).
- **§12.3 parity** — gated at F0 (must be no-op) and F4 (full run).
- **Durable-state survival** — single stored spelling + F4 re-key with §11.4 orphan quarantine;
  relink/derived-twin/content-hash suites gate F4.
- **Cycle ratchet ≤10 / fn-size shrink-only** — resolver is a new pure leaf; db trio exits the
  baseline at F4 per DoD 11.
- **No new trust machinery** — resolution is name lookup only; `trusted` untouched.
- **Frozen migrator** — never edited; it is where `type:name` parsing lives forever.
- **Script-only codemod gate** — preserved by construction (D-R2 static table); hand edits are
  segregated in F3 exactly as plan §15 rule 2 requires.
