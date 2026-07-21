# Target Design Review — Format-Neutral Bundle Workspace Architecture

> **Disposition (2026-07-13):** the recommendations in this report have been **applied to the design documents in place** — normative spec amended to v0.2 (ref grammar §7.8/§11 incl. canonical spelling/short-ref/rename/orphan/canonicalization clauses, nested-root subtraction §9.3, recognize-required + ValidateContext adapter contract §12, IndexDocument signal fields + diff persistence + item-scoped incrementality §14, trusted read-path clamp + sensitivity carve-outs §15/§28, memory-lifecycle scoping §25, acceptance criteria updates §32); adapter spec amended in the corresponding sections (probe order, collision diagnostics, diff persist, skill-validator corrections, opencode skills, links≠graph-boost, citation fixes); decision history amended (§5.4/§5.5, D8 framing) and extended (D27–D29). This report is retained as the review record; §10's checklist is fully dispatched.
>
> **Superseded-scope addendum (2026-07-14, D30):** the security/trust recommendations herein (§7 trusted-flag load-bearing read path, action clamping, generic-files sensitive refusal; the §8 memory-lifecycle 0.9.0 scope) were subsequently **withdrawn or deferred** by maintainer decision — no new trust/approval machinery ships in 0.9.0 (normative v0.3 removed the clamp clauses; only existing protections survive the port), and the memory lifecycle is deferred entirely behind the claim extractor. The identity/adapter-contract/migration recommendations stand as applied. See deviation-analysis §4.3b–3c and history D30.
>
> **Superseded-scope addendum (2026-07-21, owner ruling):** the **package-manifest** recommendations (§49 `akm.bundle.yaml`, exports, components, lock state) and the **sub-mount proposal** fix (§188 — probing well-known tool subtrees into additional components) are **withdrawn**. A bundle maps to exactly **one component = one adapter**, and that adapter processes its bundle's files/subdirectories via its own `recognize` (adapter-owned file processing); the `akm.bundle.yaml` manifest is removed from the spec entirely (it was never implemented). The consequent multi-component machinery (§284 nested-root subtraction, cross-component collisions) no longer applies. The recognize-required/index-optional core-walk contract (§158) stands and is now **live in the indexer** (per-directory drain × the dispatched `adapter.recognize`; unknown adapter id ⇒ component skipped with a warning). See the specs' v0.4 amendment records.

**Scope:** deep review of the target architecture defined by `akm-format-neutral-bundle-workspace-spec.md` (normative), `akm-0.9.0-bundle-adapter-spec.md` (reconciled adapter spec), and `akm-architecture-decision-history.md` (D1–D26), as reconciled by the four maintainer decisions of 2026-07-13.

**Method:** every load-bearing claim was verified against (a) the actual codebase at HEAD (`3fe3aef`, branch `claude/loving-keller-hz9kcx`) — no doc line numbers were trusted, all were re-located; (b) the external specifications the design builds on (OKF v0.1 SPEC.md fetched from the authoritative GoogleCloudPlatform repo; the Agent Skills spec fetched from the agentskills.io source repo and its `skills-ref` reference validator; Claude Code and OpenCode docs); and (c) adversarial design review across six dimensions (identity/refs, migration/storage, scope coherence, security/trust, improve/memory, adapter/search contract), plus empirical testing of SQLite ATTACH/transaction semantics against the actual runtime (bun:sqlite, SQLite 3.51.2).

**Companion report:** `akm-0.9.0-plan-review-2026-07.md` covers the implementation plan (claim accuracy, migration mechanics, chunk order, missing work items).

---

## 1. Verdict

**The architectural direction is sound and unusually well-reasoned.** Format-neutral kernel with adapters owning native semantics; path-based identity; one local adapter-free-at-query-time index; direct reads; `Proposal = FileChange[]` + before-hash through one transaction; evidence-driven improve with model-confidence-is-not-authority; three databases; install ≠ activation as a design principle — each of these decisions survives adversarial review, and the decision history's rejected-alternatives table (§7) is genuinely valuable regression armor. The external foundations also check out: **every factual claim the docs make about OKF v0.1 and the Agent Skills SKILL.md contract was confirmed against the authoritative sources** (details in §2–§3).

**But the design as documented is not yet implementable.** Three classes of problems block it:

1. **The documents disagree with each other on load-bearing points** — most severely, the normative spec still mandates the three-segment ref grammar that the maintainer decision (DEV-2) superseded, and the two specs disagree on whether `aliases` is a first-class index field. The reconciliation was recorded in the deviation analysis and the adapter spec, but the normative spec was never amended (§4.1).
2. **Five load-bearing identity/adapter-contract questions are unanswered**, and for each there is existing-code evidence that leaving them open causes real damage: nested/overlapping component roots (the spec's own flagship example is illegal under its own rules), index persistence that would wipe embeddings/utility state (repeating a bug this repo already fixed once), a lossy `IndexDocument` projection that cannot pass the design's own search-parity gate, canonical ref spelling, and the body-ref grammar (§4–§6).
3. **Two subsystems are specified beyond what is honestly buildable in one release**: the memory lifecycle's claim-coverage MUST gate depends on an extractor the docs themselves admit is undecided and benchmark-less, and the "refactor of consolidate.ts, not a new subsystem" framing is roughly one-third true (§8).

One security-relevant framing error should also be corrected: **"installation is not activation" is not fixing a present-day escalation** — install already grants nothing today (verified in code). The real, under-addressed security surface is the *read path*: untrusted content flowing into agent contexts with the `trusted` flag never consulted (§7).

Everything below is fixable at the spec level before implementation starts. None of it invalidates the architecture.

---

## 2. External foundation: OKF v0.1 — confirmed, with caveats the design must absorb

All eight foundational claims were verified against the authoritative spec (`GoogleCloudPlatform/knowledge-catalog` `okf/SPEC.md`, fetched raw):

| Claim in the akm docs | Verdict |
|---|---|
| Bundle = directory tree of markdown concepts (frontmatter + body) | CONFIRMED (§3, §4 of OKF spec) |
| Concept ID = path minus `.md` (`tables/users.md` → `tables/users`) | CONFIRMED (exact example matches) |
| Only required field is open `type` | CONFIRMED ("Type values are **not** registered centrally… consumers MUST tolerate unknown types") |
| Recommended: `title`/`description`/`resource`/`tags`/`timestamp` | CONFIRMED (in that priority order) |
| `index.md`/`log.md` reserved, not concepts | CONFIRMED — **at every directory level**, and both optional |
| Bundle-relative links = relationships | CONFIRMED — but **two link forms are legal**: `/`-rooted (recommended) *and* standard relative (`./other.md`). An adapter resolving only `/`-rooted links drops legal links. |
| `okf_version` exists | CONFIRMED — optional (`MAY`), lives in bundle-root `index.md` frontmatter, and the OKF spec is *internally inconsistent* about it (§6 says index files contain no frontmatter; §11 carves out the root). Google's own reference bundles don't emit it. `looksLikeRoot` probes keyed on `okf_version` (adapter-spec §1.2 item 1) will miss most real OKF bundles. |
| Consumers MUST tolerate unknown fields + broken links | CONFIRMED — bundle-level rejection is MUST NOT; the `okf` adapter's lenient validation posture is not just nice, it is **required for conformance** |

**Caveats the design should absorb explicitly:**

- **OKF is a month-old, single-vendor draft.** Header literally says "Version 0.1 — Draft"; announced 2026-06-12; no standards body, no documented change process; the hosting repo disclaims being an official Google product; zero confirmed third-party producers or consumers. The core (dir-of-md, path-as-ID, open `type`) is minimal enough that it will likely survive any v1.0, and it costs little to implement — keeping it as the *default adapter* is defensible. But the design should **vendor a frozen copy of the spec text/rules it implements** and pin behavior to it, rather than citing a living draft, and should treat `okf_version` handling as best-effort (the OKF spec itself mandates best-effort consumption of unknown versions).
- **Everything package-manager-shaped is an AKM invention, not OKF.** OKF has no manifest, no bundle/content versioning, no dependencies, no integrity/signing, no namespacing, and is silent on non-`.md` files (Google's own bundles ship a `viz.html`, tolerated with zero semantics). `akm.bundle.yaml`, components, exports, lock state are all AKM extensions layered *around* OKF — which is fine, and the hybrid decision (DEV-1) frames this correctly, but docs should not attribute these to OKF.
- **OKF sanctions `type`-based dispatch** ("Consumers use this for routing, filtering, and presentation") with mandatory graceful degradation for unknown types. The reconciled position — `type` may drive presentation/ranking but never execution/identity — is *more* conservative than OKF requires and is the right call (see §7 for why even presentation-by-type needs a trust clamp).
- **Round-trip preservation is a SHOULD** ("preserve unknown keys when round-tripping") — the adapter contract's unknown-field-preservation requirement (normative §8.2) satisfies this; keep it.
- OKF is silent on **filename case sensitivity, Unicode normalization, and path length** — which the AKM identity design must therefore specify itself (it currently doesn't; see §5.7).

---

## 3. External foundation: Agent Skills — confirmed, with validator corrections

Verified against the agentskills.io spec source (`github.com/agentskills/agentskills`, `docs/specification.mdx`), the `skills-ref` reference validator, Anthropic platform docs, Claude Code docs, and OpenCode docs:

- **`name` ≤ 64 and `description` ≤ 1024 are confirmed hard limits.** But the full `name` contract is larger: lowercase alphanumerics + hyphens only, no leading/trailing hyphen, no `--` (regex `^[a-z0-9]+(-[a-z0-9]+)*$`), and **`name` must equal the parent directory name** (NFKC-compared) — load-bearing for the "item = the dir" design and absent from the akm docs.
- **"body < ~500 lines" is a recommendation, not a rule.** The spec's body section says "There are no format restrictions"; the 500-line figure appears only as progressive-disclosure guidance, and the reference validator performs *no* body-length check. The adapter-spec's "Anthropic contract (name≤64/desc≤1024/body<~500)" phrasing lumps a soft lint in with two hard limits — the skill adapter's `validateL1` should emit at most a **warning** here; an error would be stricter than every upstream source.
- **The L0/L1/L2 terminology is akm-internal.** Upstream uses metadata / instructions / resources (Anthropic docs: "Level 1/2/3"). Keeping akm's own L0-card/L1-overview/L2-detail naming for its *retrieval* levels is fine — but the docs should stop citing it as "the SKILL.md L1 contract"; that mapping doesn't exist upstream.
- **The spec is unversioned** — no version number, no git tags, no changelog, no stability policy; `skills-ref` is 0.1.0 and "not accepting code contributions." As with OKF: **pin by vendoring the skills-ref rules**, not by citing "the spec."
- **`.claude/skills/<name>/SKILL.md` == standalone Agent Skill is one-way, not equality.** Claude Code makes *all* frontmatter fields optional (name defaults to dirname) and extends the standard with ~13 non-spec fields (`when_to_use`, `argument-hint`, `disable-model-invocation`, `context`, `hooks`, …) plus body features (`!`cmd``, `$ARGUMENTS`); `skills-ref` *errors* on unknown fields; OpenCode ignores them. So a spec-conformant skill works everywhere, but a Claude Code skill can be spec-invalid. The design's resolution — SKILL.md codec as shared functions consumed by both the `claude` and `agent-skills` adapters — is correct, **but validation strictness must be per-adapter** (strict/erroring in `agent-skills`, permissive of the documented extension fields in `claude`).
- **The `opencode` adapter's emitted-types list is stale**: adapter-spec §7 has it emitting only command/agent/instruction, but OpenCode now has first-class skills (`.opencode/skills/<name>/SKILL.md`, enforcing the same name/description limits) and also natively reads `.claude/skills/`. The `opencode` adapter should emit `skill`, and current OpenCode uses plural `commands/`/`agents/` directories.
- **Validator additions the docs missed** (fold into the skill adapter's checks): `compatibility` ≤ 500 chars; `metadata` must be a string→string map (no top-level `version` field exists — versioning goes under `metadata.version` by convention); `allowed-tools` is a space-separated string and *experimental* (portability warning); structural checks (file starts with `---`, frontmatter parses as a YAML mapping); `skill.md` lowercase fallback accepted by skills-ref but *rejected* by OpenCode (warn); Anthropic API additionally bans XML tags and the reserved words "anthropic"/"claude" in `name`.
- **Citation hygiene:** "docs.anthropic.com Agent Skills" is stale — current hosts are platform.claude.com (API) and code.claude.com (Claude Code).

---

## 4. Critical: the binding documents contradict each other

### 4.1 The ref grammar itself is specified two ways

The adapter spec (§1.3) defines the reconciled grammar — `ref := [ bundle "//" ] conceptId` — and its header says it "defers to the normative spec." But the normative spec was never amended: §7.8 and §11.1 still define the canonical ref as three-segment `<bundle-id>/<component-id>/<adapter-local-id>` with examples like `team-catalog/knowledge/tables/orders`, and normative §10.1's config example writes `export: team-catalog/workflows/release` where the adapter spec writes `team-catalog//workflows/release`. These are not different separators for the same identity — they are **different identities**: under normative §9.2, component `environment` has root `env`, so the three-segment ref is `release-automation/environment/prod` while the path-identity ref is `release-automation//env/prod`. Component *IDs* and component *root names* are distinct namespaces, and every downstream MUST (rekey targets §11.4, ref invariants §11.2, binding export refs §18) is currently specified against the grammar the project decided not to build.

**Fix:** amend normative §7.8, §11.1, §10.1, §11.3 to the reconciled grammar in the same commit that declares the reconciliation; delete the three-segment examples; and decide explicitly whether component IDs still exist as user-visible names anywhere now that the ref no longer carries them. (General rule, applied throughout this review: **the reconciliation must be applied as edits, not as a banner** — the same doc-drift failure mode the plan itself flags in code comments.)

### 4.2 `aliases`: first-class in one spec, folded away in the other

Normative §14.1's `IndexDocument` has `aliases?: string[]`; the adapter spec's `IndexDocument` (§3) drops it and folds aliases into `tags`. This is not cosmetic — see §6.3: the alias ranking contributor gives exact-alias matches a 1.5 boost vs. the tag contributor's 0.15/0.3 cap, so the fold destroys a distinct ranking signal and breaks the design's own parity gate.

### 4.3 `type`/`kind` residue

The reconciled position (open `type`, may drive presentation/ranking, never execution/identity/storage) is coherent, but normative §14.1 still says `kind` "MUST NOT select storage, execution, **rendering**, or write behavior" — which contradicts `TYPE_PRESENTATION` keying renderers on `type`. Amend §14.1 to the reconciled semantics (rendering allowed under the trust clamp of §7 below; execution/identity/storage still forbidden).

---

## 5. Identity and refs: right direction, five unanswered load-bearing questions

The reconciled direction — path-as-identity, component demoted to a derived provenance column, `[bundle//]conceptId` — is a sound simplification, genuinely OKF-aligned, and the surviving `asset-ref.ts` guards (null-byte/drive-letter/traversal, verified at `asset-ref.ts:121-136`) give it a real foundation. The `//` separator choice is good: it makes the bundle prefix unambiguous against `/`-separated paths. But:

### 5.1 CRITICAL — Overlapping component roots: the flagship example is illegal under its own rules

Adapter-spec §8 mounts `{ root: ".", adapter: "okf" }` **alongside** `workflows/`, `wiki/`, and `.claude/` components in one bundle. The okf adapter has *no directory gate* ("any `.md` not named index.md/log.md" → concept). So the okf component at root `.` also indexes `workflows/release.md`, `wiki/pages/*.md`, and `.claude/commands/test.md` — each *also* indexed by its own component's adapter, **emitting the identical ItemRef** (conceptId is bundle-relative). The only specified mitigation — "dedup by ItemRef in persistComponent" — is per-component and cannot see the cross-component duplicate. Since the persisted ref column is UNIQUE (today `entry_key TEXT NOT NULL UNIQUE`, `schema.ts:96`), each component's scan would either fail on the constraint or steal the row from the other component on every scan — ping-ponging ownership, churning the integer entry_id that FTS/vector/utility tables join on. This directly violates normative §9.3, and **no nested-root exclusion rule exists anywhere in either spec**.

**Fix:** specify nested-root subtraction as a MUST: when component roots are nested, the parent component's file set is its tree minus every other configured component root (computed once at mount registration; §9.4 already persists adapter selection). Add a config-validation error for overlap that is not strict nesting. Make the ref-column UNIQUE constraint explicit and require persistComponent to treat a cross-component ref collision as a component-scoped indexing error, not a silent upsert. Fix the §8 example.

### 5.2 MAJOR — Canonical ref spelling and short-ref resolution in portable content

Two unanswered questions that today's code proves are expensive to leave open:

- **Canonical stored spelling.** Are `personal//knowledge/foo` and `knowledge/foo` (when `personal` is the default bundle) the same state.db key? Today's `rekeyStateDbForMove` must probe *three* spellings of every ref (bare, `local//`, `<sourceName>//` — `mv-cli.ts:940-946`) precisely because this was never pinned and history accreted under whichever spelling callers used. **Mandate: all durable state keys and index rows store the fully-qualified `bundle//conceptId` form, always; the short form is CLI input sugar resolved at parse time.**
- **Short refs inside portable content resolve to the wrong bundle.** A short ref `knowledge/http-caching` written in a file that *ships inside* bundle `team-catalog` would resolve to the *installer's* workspace default bundle, not the containing bundle — a shared bundle's own cross-references silently retarget per consumer. And bundle-qualified refs can't be written in portable content either, because `BundleId` is workspace-local by design. **Mandate: short refs in bundle content resolve to the containing bundle** (portable by construction), and prefer OKF-style relative links for intra-bundle references (the mechanism already exists in §9 of the adapter spec).

### 5.3 MAJOR — Bundle rename has no rekey semantics

`BundleId` is a user-chosen workspace name embedded in every ref, and every durable state row is keyed on ref TEXT (`asset_salience`, `asset_outcome`, `events.ref`, proposals, bindings). Renaming a bundle is a one-line config edit that silently orphans *all* of it — a mass identity migration with no file moving, covered by neither §11.2 (move rekey) nor §11.4 (one-time migration). Cross-workspace ref exchange has the same hole: two teammates installing the same package under different bundle names produce mutually meaningless refs, and the manifest's upstream package name is unused for addressing.

**Fix:** add `akm bundle rename <old> <new>` running the same rekey transaction family as `akm mv` (index rows, state tables, bindings, config, atomically); have startup detect a config bundle-id whose index/state rows exist under a missing id and refuse/warn rather than silently re-minting. For cross-workspace exchange, either record the manifest package name in lock state as a resolvable alias or document loudly that refs are workspace-scoped and must not be shared.

### 5.4 MAJOR — conceptId collisions are silent and nondeterministic

Extension stripping makes same-id collisions easy inside one component: the workflow family recognizes `.md`/`.yaml`/`.yml`, so `workflows/release.md` and `workflows/release.yaml` both yield `workflows/release`. "Dedup by ItemRef" doesn't specify which file wins (walk order — platform-dependent), emits no diagnostic, and leaves the loser on disk, invisible to search and lint yet still writable. Worse, because state is keyed by ref, deleting the winner later *resurrects* the shadowed file under the same ref — inheriting the other document's entire utility/outcome history.

**Fix:** make collisions a validation diagnostic (`duplicate-concept-id` naming both paths), define a total order (adapter-declared extension priority), and record the loser's path so resurrection after deletion resets rather than inherits state history.

### 5.5 MAJOR — The body-ref grammar dies with the type alternation, and nothing replaces it

Today, finding refs in prose (lint's missing-ref scan, `akm mv`'s inbound-xref rewriting, search's `type:` prefix queries) is anchored on the registry-derived type alternation — `(knowledge|workflow|…):slug`. In the new grammar, `type` never appears in a ref, and a short ref like `knowledge/http-caching` is lexically indistinguishable from any relative path or identifier in prose. Bundle-qualified refs at least carry `//` — but `//` occurs in every URL. The adapter spec (§3.4) still points at "parseRefPrefixQuery + base-linter REF_RE" — machinery whose grammatical premise it just deleted — with no redesign.

**Fix:** give body refs a syntactic anchor. Options, best first: an explicit sigil/URI form for prose refs (`akm:bundle//path` or `[[bundle//path]]`); or require fully-qualified `bundle//conceptId` in content with a bundle-slug charset that excludes `:` and `.` (kills the URL collision). Rewrite §3.4 accordingly. Without this, `akm mv`'s xref rewriting becomes either lossy or actively destructive.

### 5.6 MAJOR — The §11.4 "MUST rekey" is not computable for orphaned state rows

State tables provably hold keys for items with no file and no index row (deleted-memory `consolidation_judged` entries retained by design; append-only `events.ref` usage history; mv's own collision policy assumes orphan salience rows exist). For an orphan `knowledge:foo` the `type:name → path` relation is filesystem-dependent and sometimes undefined (`script` refs are contract-pinned unresolvable even with the file present). A literal zero-orphan rekey can never complete on a mature install — see the companion plan review §4 for the migration-side consequences.

**Fix (design side):** specify the migration as a join against the last-good index (entry_key → file_path → conceptId), never TYPE_DIRS path reconstruction; define an explicit orphan policy (quarantine to a `legacy_state` archive table — auditable, purgeable — rather than dropped or dual-parsed); and define a deterministic per-table merge function for the multi-spelling collisions (bare/`local//`/`origin//` all mapping to one new key).

### 5.7 MAJOR — Path identity is silent on case, Unicode, and separators

conceptId becomes the primary key for the index and all durable state, yet neither spec says anything about case folding, Unicode normalization, or separator canonicalization. Concrete failure modes: a bundle authored on Linux containing `Foo.md` and `foo.md` silently drops one when indexed on default-APFS macOS; macOS NFD filenames give a conceptId containing `é` two byte-distinct spellings (NFC from user input vs NFD from readdir) that compare unequal as TEXT keys, orphaning state.

**Fix:** add a canonicalization clause to §1.3/§11: separators normalized to `/`; NFC normalization at index/parse time; identity byte-wise case-sensitive; plus an index-time `case-collision` diagnostic for files that differ only under case-fold or NFC/NFD. Promote validateName's traversal/null-byte/drive-letter guards from implementation detail to normative MUSTs.

### 5.8 MINOR — Smaller grammar gaps

- **`#fragment`** (normative §11.3, DEV-9) is absent from the reconciled grammar; `#` is legal in filenames, so `bundle//dir/file#frag` is currently ambiguous. Add `["#" fragment]` to the production and forbid `#` in conceptId at validateName level.
- **OKF link resolution frame:** when the okf component root is not `.` (normative §9.2 mounts okf at `root: knowledge`), OKF concept ids and `/`-rooted links are component-root-relative while AKM conceptIds are bundle-relative. Specify: links resolve against the component root, then re-prefix with the component root to form the stored conceptId; and scope the "an AKM knowledge bundle *is* a valid OKF bundle" claim to okf-at-`.` bundles.
- **The "core MUST NOT parse a file path out of a concept ID" invariant is already half-broken by the spec itself** (component derivation parses leading segments; `placeNew` returns `<conceptId>.md`; mv's `.derived`-twin string surgery). Restate it precisely: the core resolves conceptId→path only via the index; adapters own both stripping directions; the core MAY treat conceptId as a `/`-segmented string for prefix matching but MUST NOT reconstruct filesystem paths from it. Define longest-match extension stripping so `foo.yaml.md` has one answer.

---

## 6. Adapter contract and index/search: four contract-level defects to fix before any adapter is written

One structural win is real and should be protected: **one adapter per component root genuinely kills the matcher specificity contest** (`file-context.ts:242-265`), the single most tangled part of today's recognition. The following defects are all fixable at the contract level — and should be, before Chunk 2 mints ten adapters against the current interface.

### 6.1 CRITICAL — Truncate-and-rewrite persistence destroys entry_id-keyed state and contradicts two of the spec's own promises

Adapter-spec §4 mandates persistComponent as "one txn, truncate-and-rewrite the component's rows" while §3 promises the migration keeps "the integer row id for FTS/vector joins." These are mutually exclusive: truncating `entries` mints new AUTOINCREMENT ids, and everything keyed on entry_id dies — embeddings/`entries_vec`, `utility_scores(_scoped)`, `usage_events.entry_id`, FTS rows. **The repo already paid for this lesson**: #624-P1 re-keyed the graph tables off `entries.id` precisely so a reindex delete/re-insert "no longer cascade-wipes the extracted graph" (`schema.ts:234-240`), and today's full rebuild deliberately detaches usage_events (nulls entry_id, keeps entry_ref for re-link, `indexer.ts:970-976`). Under the new rule, *any* change in a component — or any adapterVersion bump — truncates the whole component, forcing full re-embedding of unchanged items and erasing utility EMAs. Two adjacent unspecified hazards: the async `index()` iterable vs. synchronous SQLite transactions (today's code splits async scan from sync persist for exactly this reason, `indexer.ts:718-723`) and the zero-document scan (an unmounted network drive is indistinguishable from a legitimately emptied root; today `inferZeroRowReason` classifies this).

**Fix:** replace truncate-and-rewrite with a **diff persist**: (1) fully drain/spool `adapter.index()` *before* the write transaction — this alone makes "last-known-good on failure" true by construction; (2) upsert by item_ref with ON CONFLICT DO UPDATE (preserves entries.id; skip re-embed when content_hash is unchanged), then delete only rows whose item_ref disappeared, through the existing `deleteRelatedRows` cascade with the usage_events detach-and-relink behavior; (3) re-key utility/usage tables on item_ref during the schema migration so even id churn can't destroy behavioral state; (4) require adapters to distinguish "root missing/unreadable" (throw → preserve) from "root empty" (yield nothing → legitimate delete), e.g. a mandatory root-stat preflight in core.

### 6.2 MAJOR — Requiring both `index()` and `recognize()` creates a dual-codepath split-brain and ten copies of the security-bearing walk

Today the walk is a single core implementation with load-bearing policy: git-aware traversal, symlink refusal (on the plan's binding preserve list), SKIP_DIRS. Making `index()` required on all ten adapters means either ten reimplementations of a security-relevant traversal, or ten boilerplate wrappers — and either way, `index()` (exercised by the parity gate) and `recognize()` (the steady-state incremental path) are two codepaths for the same mapping that can silently diverge. This is exactly the split-brain shape the plan condemns in the renderer registry.

**Fix:** make `recognize()` the required primitive and `index()` optional. Core owns `scanComponent(c, adapter)` = core walk × `recognize` per file. Adapters with genuinely non-per-file layouts (website-snapshot, llm-wiki) override `index()`, and an overriding adapter must either keep `recognize` coherent (conformance fixture: `index()` output == fold of `recognize` over the walk) or declare component-level incrementality.

### 6.3 CRITICAL — `IndexDocument` is not a lossless projection of `StashEntry`; the parity gate fails as specified

The five FTS columns and bm25 weights do map cleanly. But roughly **ten fields that core ranking contributors and result filters read at query time** are demoted to the opaque `documentJson` blob the spec forbids core from parsing: `aliases` (exact-alias 1.5 boost vs tags' 0.3 cap — and the two specs disagree on this field, §4.2), `searchHints` (array contributor, not the FTS column), `quality` (curated boost *and* the proposed-by-default exclusion filter), `confidence`, `beliefState` + `currentBeliefRefs`/`supersededBy` (boosts, score ceilings, and the `--belief` filter — the load-bearing corrections-demotion feature), `scope_*` filters, `captureMode` hot boost, `lessonStrength`, fact `pinned`, `fileSize` (hit size + estimatedTokens), and `derivedFrom` (drives derived-twin belief inheritance via a real column). Run the mandated deterministic nDCG/MRR/banned-hit gate against IndexDocument-as-specified and it fails wherever these fire — or worse, the filters silently stop applying, a behavior change rank metrics may not even catch.

**Fix:** promote everything core consumes at query time to first-class IndexDocument fields, or define one core-parsed `signals` sub-object with a pinned, linted schema (documentJson stays opaque only for true adapter extras). Ship the FTS folding rules (examples/usage/intent/xrefs → hints/content) as a **core helper adapters call** — one fold, not ten. Extend the §14.4 cutover gate beyond rank metrics to **filter-behavior parity** (proposed/belief/scope result sets) and whyMatched parity, and schedule the canary re-mint as a named migration step.

### 6.4 MAJOR — Per-file incrementality cannot express the spec's own directory-scoped items

The mount manifest (`files: {path → hash,mtime}`; "a single changed file calls recognize and upserts one row") is undefined for the spec's own new item shapes: `skill` — *item = the dir* — where editing a sibling (`reference.md`, a script) must update the item but `recognize(sibling)` returns null; llm-wiki, where `schema.md` governs every page's validation. Today's incrementality unit is the *directory* (dir-staleness fingerprints; whole-dir regenerate), which keeps multi-file items coherent by construction.

**Fix:** make the incremental unit the ITEM: either an optional `affectedItems(c, changedPaths) → conceptId[]` (default: identity) with core re-running recognition for every file of an affected item, or change `recognize`'s input to an ItemContext carrying the item's file set, with per-item file sets stored in the manifest. Adapters declare "coupling files" (wiki `schema.md`) whose change escalates to component rescan. Explicitly carry forward the FTS dirty queue and the zero-row dir-state cache into the new manifest design.

### 6.5 MAJOR — `validate(c, changes)` is context-starved

Real validators need more than `{path, before?, after?, op}`: wiki xref checks need sibling pages + schema conventions; the skill contract needs the dir's other files; okf's `missing-ref` warning needs link-target resolution; and multi-file proposals mean validating change N must see changes 1..N−1 applied. Letting each adapter read disk pre-commit both races concurrent writers (undermining the before-hash rule) and violates the one-snapshot principle the design enforces elsewhere.

**Fix:** `validate(c, changes, ctx: ValidateContext)` where core supplies (a) `readFile`/`list` served from the run's snapshot **with pending changes overlaid** (one core overlay implementation, not ten), (b) `resolveRef(ref) → {exists, path}` backed by the index for cross-component link checks (read-only lookup, not search), and (c) the component's file listing. Assign cross-component ref existence checking to core explicitly — today it belongs to neither party.

### 6.6 MAJOR — "Renderer/action as a data table" papers over real renderer *code*, including security behavior — and the raw-read rule would defeat redaction

The type→renderer-name *mapping* can be a table (that's all `asset-registry.ts` is). The renderers themselves are behavior: the env renderer returns key names only and deliberately omits content; the secret renderer never reads the body; the script renderer derives exec hints; knowledge/wiki implement view modes; renderers register nine index-time metadata contributors. The three documents currently disagree on where this code lives (plan DoD: "no renderer registry remains"; plan §4.3: keep the file-context renderer registry; adapter spec: adapters do *not* own renderers). And normative §15.3/§15.4's "reads are a plain `fs.readFile`; show MUST NOT run renderer registries" — applied literally to env/secret items — **prints raw secret values**, undoing exactly what those renderers exist to prevent.

**Fix:** keep the table for the mapping; name the surviving home for renderer *code* (a small static core module of named renderer functions); reword the DoD to "no type-competition registry." Carve an explicit normative exception: sensitivity-suppressed presentation is keyed on **adapter** (dotenv/secrets components), never on the open `type`, so frontmatter can't opt out of redaction and a generic fallback can't dump an `.env`. Extend the action signature to `(ref, ctx: {trusted, adapterId})` so directive-shaped actions can respect provenance (see §7). Move the nine metadata contributors into the owning adapters' `recognize` — that part of the port is clean.

### 6.7 MAJOR — Adapter selection has no deterministic probe order

Ten adapters, `looksLikeRoot` probes, "defaulting to okf" — with no priority or tie-break, despite normative §9.4 requiring a deterministic winner. Concrete conflicts: a root `SKILL.md` package probes true for both `agent-skills` and `okf`; `generic-files` is trivially always-true. And the no-manifest default (one component `{root: ".", adapter: okf}`) silently mis-types embedded tool dirs — for a repo containing `.claude/`, okf indexes `.claude/commands/*.md` as `knowledge` concepts instead of the claude adapter's derived command/agent/skill types.

**Fix:** specify an ordered probe list, most-specific first (manifest > okf-with-okf_version > llm-wiki > claude > opencode > agent-skills > … > okf fallback; `generic-files` never auto-selected — explicit config only); probes must be pure and results persisted. Add default **sub-mount proposal**: the no-manifest scan probes well-known tool subtrees (`.claude`, `.opencode`, `workflows/`, `tasks/`, `env/`, `secrets/`) and proposes them as additional components, so the okf-everything default doesn't swallow tool dirs. Note the `okf_version` caveat from §2: since even Google's reference bundles omit it, the okf probe cannot *require* it.

### 6.8 MAJOR — "OKF links replace LLM graph extraction" is technically incoherent as stated

The existing graph signal is entity-*lexical*: query tokens match extracted entity strings, expanded over an entity adjacency with per-edge confidence (`graph-boost.ts`). Doc-level link edges supply none of that — a link edge has no entity strings to match, and its only lexical handle (the target concept-id) duplicates the FTS name column at weight 10. `IndexDocument.links` also has no specified persistence or query-time consumer. So "replaces" either smuggles in an unspecified, unbenchmarked new link-boost (contradicting the design's own burden-of-proof rule) or silently turns graph boost off for OKF content.

**Fix:** rewrite adapter-spec §9 to match normative §26.3, which already has the defensible version: links are deterministic *relationship/navigation* data — define their table (`item_links(src_ref, dst_concept_id)`) and consumers (L1 overview, `related` output, broken-link lint) — and state explicitly that links do **not** feed `computeGraphBoost`; graph extraction and its boost remain a separately measured concern resolved by the ablation pass.

---

## 7. Security and trust: the marquee principle is aimed at the wrong threat

### 7.1 "Installation is not activation" is not fixing a present-day escalation — re-characterize it

Verified in code at HEAD: `akm add` and the registry install path only sync content and index it. Task scheduling scans **only** the primary writable stash (`akmTasksSync` reads `resolveStashDir() + /tasks`, never `config.installed[]` roots) and is invoked only from the tasks CLI. Env values require explicit `akm env run`, and `resolveEnvBinding` already hard-blocks process-hijacking keys for any registry-installed origin. Workflow runs require an explicit command. So **for a registry-installed bundle, install is already not activation.** The deviation analysis's justification for restoring bindings ("task scheduling, env injection, and workflow runs already happen at/after install today — that *is* implicit activation") is factually wrong. Bindings/activation remains defensible as a *portability/correctness* design (multi-bundle distribution of runnable exports genuinely needs it, digest pinning on update is real), but the docs should stop citing a non-existent escalation — it inflates the security value of a new subsystem and creates a false sense that the actual threat surface is being handled.

### 7.2 MAJOR — The real threat is the read path: `trusted` is declared but never consulted

`BundleInstallation.trusted` exists in the durable model ("explicit trust; installation grants nothing") — but **no search or show section consults it**. Normative §15.1 requires unknown kinds to remain searchable, §28.2 permits indexing untrusted content, and `trusted` appears nowhere in §15/§15.4 or the adapter spec's render tables. Meanwhile the read path emits attacker-controllable strings *plus imperative agent directives* (`action` strings like "→ execute the run command", "→ dispatch with full prompt") into agent contexts. The design newly makes default-mounting arbitrary repos easy (lenient okf default) while leaving the trust flag decorative.

**Fix:** make `trusted` load-bearing in the normative read path: search/show MUST suppress or clearly quarantine-label results from untrusted installations and MUST NOT emit executable-flavored action directives for them; add an acceptance test for it.

### 7.3 MAJOR — `type`-from-frontmatter hands untrusted authors the action-string selector

Today, `type` is *derived* by matchers from directory placement and constrained content probes (a file only classifies as agent/command on specific frontmatter keys). Under the okf adapter, `type` comes verbatim from frontmatter — so a malicious `.md` in a default-mounted bundle declares `type: script` and gets the script renderer's "execute"-flavored action in `akm show`/search output. Real execution still needs a binding, so this is confused-deputy pressure rather than direct RCE — but it is a strict widening of attacker influence over agent-facing directives vs today.

**Fix:** for untrusted/default-mounted content, clamp to the neutral generic renderer + plain `akm show <ref>` regardless of declared `type`; honor executable-flavored actions only for trusted or explicitly-bound content. Conformance test: `type: script` in an untrusted okf bundle yields the generic action.

### 7.4 MAJOR — `generic-files` creates a value-leak surface with no analog today

Today, unmatched files are simply not indexed, and env/secret protections are directory-scoped (env matcher under `env/`, secret under `secrets/`, content-read bails). `generic-files` — "any leftover file → searchable" — would index the *content* of a stray `.env`, `.pem`, or credential file sitting outside a dotenv/secrets component root.

**Fix:** `generic-files` MUST apply sensitive-content refusal (no body read for dotenv/credential-shaped files) or must not claim them; conformance test with a stray `.env` outside `env/`; consider making `generic-files` explicit-config-only (which §6.7's probe-order fix also implies).

### 7.5 Port-preservation items

- **The origin-scoped dangerous-key asymmetry** (hard error for third-party/registry origins, warn for first-party) rides on `config.installed[]`/`registryId`, both of which the redesign deletes. Map it explicitly onto `BundleInstallation.trusted` before deleting `installed[]`, with a conformance test (untrusted bundle env export containing `LD_PRELOAD` → hard error).
- **The retirement archive must be owner-only**: §25.8 specifies no filesystem mode while §25.9 routes *unsafe/sensitive captures* into it; today's `archiveMemory` writes world-readable. Require 0600/0700 normatively.
- **§28.4's secret-exclusion list omits state.db/Binding rows**, which are durable and backed up. State normatively that a Binding stores only references/handles to secrets, never resolved values; restrict the "literal override" to declared-non-secret values enforced at bind time.
- **Website/archive protections are well-preserved** (SSRF re-validation on every redirect hop, tar hardening, npm integrity) — the residual is preserved-from-today weak integrity for git/unknown-hash sources; since the design encourages mounting arbitrary git repos, tighten §17: pin resolved revisions in lock state and treat unrecognized-integrity-⇒-skip as a hard failure for untrusted sources.

---

## 8. Improve and memory lifecycle: right principles, over-specified for one release

The core improve redesign is the best-argued part of the whole document set: the proxy-quality diagnosis (validators prove validity, not improvement) is correct and grounded in real code history; the corrective-evidence gate, one-snapshot rule, verification ladder, and the "must earn their way back" list all survive review. Verified specifics worth recording:

- **All six deleted lanes are real and deletable** — but two are **default-ON live behavior, not dead code**: self-consistency Jaccard voting fires for every ref with utility ≥ 0.7 (3× reflect calls on the hottest refs), and the P0-A high-retrieval lane is currently the *only* path by which never-rated assets get improved. Deleting both is right per the evidence rules, but they belong in an explicit **behavior-change ledger**, not the dead-code bucket. Same-run multi-cycle is confirmed real (`improve.ts:939` cycle loop with re-index between cycles — precisely what D19 forbids; default 1, so deletion is default-behavior-preserving).
- **Three verbs: keep them.** The debate is substantive at the transaction layer — "the only op that may retire source content" names a genuinely different safety envelope with its own verification contract — and naming-only at the recipe layer. Cleanest factoring: implement consolidate's formalize path *as* an internal learn-recipe invocation plus a retirement transaction. (Plan §6's leftover "re-expressed as non-destructive learn recipes — never hard-delete" phrasing contradicts §25's purge and must be struck.)
- **Fingerprints (23.6/9.5) are a genuine unification** of the existing signal-delta gates and the judged-state content-hash cache — but as specified they lose two behaviors: retry-after-model-upgrade (no model/engine id in the hash — add one) and rejection-backoff damping (on an actively-used ref, new evidence mints a new fingerprint the day after a human rejected a near-identical proposal — retain the per-ref rejection backoff as a second guard).

The problems are concentrated in the memory lifecycle's scope honesty:

### 8.1 MAJOR — "A refactor of consolidate.ts, not a new subsystem" is about one-third true

Itemized against HEAD: of §25.5's thirteen pipeline steps, nine have working analogues in the ~6,200-LOC consolidate/dedup/memory-improve cluster (snapshot/narrowing, deterministic dedup, clustering, classify, successor generation + validation, proposal-by-default, journal/backup, contradiction preserve-and-qualify, reindex-once). But the **safety core of the story is the new part**: operational state machine (retired/quarantined/grace/restore/holds) — none exists (today "retired" is an irreversible move + delete); high/low-water + backpressure — zero hits repo-wide; claim coverage — zero (the nearest analogue, the merge-information floor, is observe-only by design); sandbox-index non-regression — raw material exists (canaries, rank metrics, per-query usage logs) but the *gate* runs post-apply against the live index, never pre-apply against a sandbox; content-addressed archive/purge/holds — zero; read-only overlay — zero; cross-bundle two-phase — ~10%. Realistic net-new: **3,500–6,000 src LOC plus tests.** The spec should say "the consolidation ENGINE is a refactor; the lifecycle STATE MODEL is new construction around it," and the release plan should budget accordingly.

### 8.2 CRITICAL — The claim-coverage MUST gate makes the lifecycle unshippable as specified

§25.6: every durable source claim MUST have a disposition; no disposition blocks retirement. But History §14.6 admits the claim-extraction implementation is undecided and needs a benchmark "before auto-retirement depends on it," and §33 defers it — a MUST gate whose evaluator doesn't exist blocks by construction. Enforced literally, *all* semantic retirement is blocked, which is a **capability regression vs today** (current consolidate genuinely reduces the tier under guards) — or worse, it incentivizes a rubber-stamp extractor. And if the coverage map is produced by the same LLM that generated the successor, the gate is exactly the self-assessment pattern D17 rejects.

**Fix:** re-scope §25.6 explicitly — claim coverage is a MUST **only for unattended** semantic retirement; human proposal approval satisfies the disposition requirement in reviewed mode (§25.9 already defaults semantic ops to proposals, so this is consistent). Ship the first release with unattended semantic retirement OFF, deterministic auto-retirement (25.9 rows 1–4) ON, and semantic ops proposal-gated. Build the extractor + benchmark next release; require the coverage verifier to be independent of the generating model.

### 8.3 MAJOR — The backpressure queue displaces unboundedness instead of solving it

`backgroundIntakeWhenBlocked: queue` has no bound, no eviction, no storage location, no drain semantics — under exactly the scenario backpressure exists for, the design converts unbounded memory files into an unbounded evidence backlog. **Simpler and defensible:** blocked background extraction just *skips* with a health warning; sessions remain the durable evidence store and re-extraction picks them up when pressure clears. One fewer memory tier to manage. If a queue is kept, bound it (items + bytes + max age, eviction policy, drain order).

### 8.4 MAJOR — The archive mandate reverses a deliberate, signed-off deletion without acknowledging it — and two retirement encodings coexist in the docs

`consolidate.ts:1921` records: "[signoff 2026-06-15] TTL archive cleanup machinery RETIRED (WS-3a)… git history is the recovery path." §25.8 now mandates rebuilding a superset of what was deleted, and D22/D23 argue from first principles as if the question were fresh. The reversal may well be right (read-only components, non-git-backed bundles, format-independent recovery — §25.8's "Git history is an additional recovery path, not the only one" gestures at it) — but it must be an explicit decision-register entry (**D27**) that engages the WS-3a rationale. Separately, plan §6 ("reuse `archiveMemory`; **one supersession encoding only**; do not add a second representation") directly contradicts spec §25.2/§25.8 (workspace CAS + state records; semantic status must NOT double as operational state — which is precisely what `archiveMemory`'s `status: superseded` stamp does). Pick one: bundle-local archiveMemory as a bounded stopgap, workspace CAS as the target, and delete the contradicting sentence.

### 8.5 Remaining lifecycle precision items

- **D19 vs the pipeline:** compatible *only if* the step-9 sandbox is built from the frozen snapshot + candidate changes (never the live index) — add that sentence; and grace/purge (steps 12–13) need a named scheduler home outside the improve run (a deterministic lifecycle sweep at run start + an explicit `akm memory purge`), consistent with §24.6's "no improve-owned retention."
- **Pressure vs preservation (24.4 vs D23):** not circular as written, but the "intentionally discarded with recorded reason" disposition is the leak path — bind it to an authority that is not the generating model (deterministic policy allowlist in unattended mode; otherwise forces review), and add: "pressure state MUST NOT be an input to disposition classification." The cautionary tale is already in the code: the consolidate LLM silently deleted 14 user-captured memories as "redundant" before the hot-capture guard landed.
- **Sandbox non-regression, honest v1:** FTS-only replay of canaries + logged per-source queries with successor-following, reusing `scoreCanary`/rank-metrics (~800–1,500 LOC of glue), advisory-blocking for unattended retirement only; full rank-parity replay belongs after the ranking ablations. Extend usage-event retention for memory-tier entries (or snapshot per-source query lists at capture time) so the 90-day window doesn't starve the gate.
- **Dependency alert:** §25.7's canary gate depends on the collapse/canary machinery that the implementation plan schedules for probable deletion in its measurement pass. The canary probe + store must move to the preserve list (or the gate must name its replacement). Flagged in detail in the plan review.

---

## 9. Storage, bindings, and remaining design notes

- **Three-DB model (D26): sound.** workflow.db's merge into state.db is right (same durability class, atomic run/event transitions), logs.db staying separate is right. Note one factual correction for the docs: `storage/locations.ts` lists only three DBs today — logs.db's path lives separately in `core/logs-db.ts`; and the single-seam claim has two exceptions (`migration-backup.ts` and `config-migrate.ts` open workflow.db directly). Migration *mechanics* — including a data-loss defect around `usage_events` — are covered in the plan review.
- **Bindings: keep, but as what it is.** Given §7.1, bindings should be presented as the portability/distribution design it is (install third-party automation → approve → enable, digest-pinned updates), with its real security contribution being *update tamper detection* (§18.5) rather than closing an install-time hole. The Binding record needs the §7.5 secret-handling clause. The lifecycle (install→index→bind→enable) is well-designed; D8's three-action separation (13.2) is correct.
- **Progressive disclosure (L0/L1/L2):** sound as a retrieval behavior with derived artifacts in index.db (13.11 is right to refuse sidecar files). Rename internally or keep — but stop attributing the numbering to Agent Skills (§3).
- **CLI direction (§29) is coherent** with the model (bundle/registry/bind families; folding wiki/manifest/curate). It is SHOULD-level; the plan review covers the sequencing problem (the plan deletes commands whose replacements it never schedules).
- **The evidence-driven improve references** (self-correction limits, judge bias) were spot-checked and are real papers accurately characterized; the memory-systems citations (Zep, A-MEM, generative agents) are consistent with how they're used (principles, not blueprints).

---

## 10. Consolidated recommendations (design-level gate before implementation)

**Do first — document reconciliation (cheap, mechanical):**
1. Amend the normative spec in place to the reconciled grammar (§7.8, §11.1, §10.1, §11.3) and the reconciled `type` semantics (§14.1); resolve the `aliases` contradiction (promote it — the ranking evidence says first-class); strike every superseded passage in all docs (grep-gate the docs the way the plan grep-gates code: "Do NOT mint", "two verbs", "fold into knowledge" → 0).
2. Add decision-register entries: D27 (archive — supersede WS-3a explicitly, with reasons), D28 (STABILITY.md ref-contract break + deprecation posture — see plan review), D29 (canonical ref spelling + short-ref resolution rules).

**Identity/ref clauses to add (§5):** nested-root subtraction MUST + overlap validation; fully-qualified refs in all durable state; containing-bundle resolution for in-content short refs; `akm bundle rename` rekey; orphan taxonomy + merge function for the one-time migration; duplicate-concept-id diagnostics with deterministic extension priority; body-ref sigil or anchored grammar; NFC/`/`-separator/case-collision canonicalization clause; `#fragment` production; OKF link resolution frame.

**Adapter contract changes (§6) — before any adapter is written:** recognize-required/index-optional over a core-owned walk; diff-based persist keyed on item_ref (drain-before-transaction, zero-document semantics); first-class query-time signal fields (or a pinned `signals` object) + filter-parity added to the cutover gate; item-scoped incrementality with coupling-file escalation; `ValidateContext` (snapshot+overlay reads, resolveRef); named renderer-code module + adapter-keyed sensitivity suppression + trust-aware action signature; ordered adapter probe list + tool-dir sub-mount proposals + generic-files as explicit-config-only; links-as-relationships (not graph-boost replacement).

**Security clauses (§7):** make `trusted` load-bearing in search/show; clamp action strings for untrusted content; generic-files sensitive-content refusal; port the dangerous-key block/warn asymmetry onto the trusted model with a conformance test; owner-only archive modes; state.db/Binding added to §28.4's exclusion list; re-characterize DEV-3 as portability/correctness.

**Memory lifecycle scope (§8):** claim coverage MUST only for unattended retirement (human approval = disposition authority); first release ships deterministic auto-retirement + pressure/health + review-gated semantic proposals + operational retirement records + FTS-only sandbox replay; extractor+benchmark, rank-parity replay, cross-bundle two-phase, read-only overlay, purge automation, and quarantine automation staged to the following release; skip (or bound) the backpressure queue; one archive encoding; behavior-change ledger for self-consistency voting and the P0-A lane; model-id in fingerprints + retained rejection backoff.

**External-spec hygiene (§2–§3):** vendor frozen copies of the OKF spec rules and the skills-ref validation rules; handle both OKF link forms; don't require `okf_version` in probes; per-adapter SKILL.md strictness (strict in `agent-skills`, extension-tolerant in `claude`); `opencode` adapter emits `skill`; body-length as warning; fix stale citations.
