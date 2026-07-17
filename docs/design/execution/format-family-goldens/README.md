# Format-family goldens — methodology (SPECIFICATION goldens)

**What this is.** A **separate, un-frozen** set of expected-output goldens for the
akm 0.9.0 format families that do NOT yet have goldens — everything in the §7
adapter registry except `okf` and `akm` (which are DONE: `all-types` + `okf-sample`).
These are **SPECIFICATION goldens**: authored from the spec (`docs/design/akm-0.9.0-bundle-adapter-spec.md`
§6/§7 + the normative spec) and grounded in how each format actually looks in the
wild — NOT captured from code, because the adapters they target **do not exist
yet** (only `okf` + `akm` are built under `src/core/adapter/adapters/`). Each
golden is the target a future adapter must hit, so that adapter can be built
test-first.

**Scope.** 9 format families × 4 golden kinds = **36 goldens**, under
`tests/fixtures/format-family-goldens/<format>/{recognition,placement,lint,renderer}.json`,
each backed by a minimal, realistic fixture bundle under
`tests/fixtures/bundles/<format>/` (with a per-format `README.md`).

| format | fixture root | adapter built by |
|---|---|---|
| `claude` | `tests/fixtures/bundles/claude/` | future Chunk-2 format-adapter WI |
| `opencode` | `tests/fixtures/bundles/opencode/` | future Chunk-2 format-adapter WI |
| `agent-skills` | `tests/fixtures/bundles/agent-skills/` | future Chunk-2 format-adapter WI |
| `akm-workflow` | `tests/fixtures/bundles/akm-workflow/` | future Chunk-2 format-adapter WI |
| `akm-task` | `tests/fixtures/bundles/akm-task/` | future Chunk-2 format-adapter WI |
| `dotenv` | `tests/fixtures/bundles/dotenv/` | future Chunk-2 format-adapter WI |
| `website-snapshot` | `tests/fixtures/bundles/website-snapshot/` | future Chunk-2 format-adapter WI |
| `generic-files` | `tests/fixtures/bundles/generic-files/` | future Chunk-2 format-adapter WI |
| `llm-wiki` | `tests/fixtures/bundles/llm-wiki/` | **Chunk 4** (DEV-7 restore) |

---

## 1. How the Chunk-0b golden shape was mirrored

The frozen Chunk-0b goldens
(`tests/fixtures/goldens/{recognition,placement,lint,renderer}/all-types.json` +
`okf-sample`) are the methodology these mirror. Each keeps the SAME outer
envelope — `scenario`, `notes[]`, and the per-kind body key
(`byRelPath` / `byType` / `perType`) — plus three additions that mark them as
spec-authored rather than captured:

- `"specificationGolden": true`
- `"capturedAtHead": null` (nothing was captured — the honest value; the frozen
  goldens carry a real sha here)
- `"adapterStatus"`, `"specSource"`, `"realWorldSource"` — every golden cites the
  spec section(s) grounding each expected value and the real-world source(s).

**Shape adaptation (documented in every golden's `notes`).** The frozen
`recognition/all-types.json` pins the OLD `runMatchers` `MatchResult`
(`{type, specificity, renderer}`). The format families here are served by NEW
`IndexDocument`-producing adapters (`recognize()` returns an `IndexDocument`, per
`src/core/adapter/types.ts`), so:

- **recognition** `byRelPath` values are the `recognize()` projection
  (`{recognized, adapterId, type, conceptId, ref, name, description?, links?, …}`)
  or `{recognized:false, reason}` for an abstention. `specificity` does not apply
  (it is a `runMatchers` concept, not an adapter concept).
- **placement** `byType` values are `placeNew(component, conceptId)` → a
  component-root-relative POSIX path, plus documented edge cases (mirroring the
  frozen workflow/env/secret probe branches).
- **lint** `perType` values are `validate()` → `Diagnostic[]`
  (`{file, issue, detail, fixed}`, per `types.ts`) — `[]` for conformant files,
  the expected diagnostic(s) for a violation.
- **renderer** `byRelPath` values are `presentationFor(type)` = `{label, renderer,
  action}` from `src/core/type-presentation.ts` (presentation is keyed on the
  open `type`, not the adapter), plus a `redaction` block for `dotenv`.

The field shapes are grounded in the two built reference adapters
(`okf-adapter.ts`, `akm-adapter.ts`) and `types.ts` `IndexDocument`.

---

## 2. What each golden kind asserts, per format

- **recognition.json** — for every file in the fixture: what `recognize()`
  classifies it as (adapter, open `type`, conceptId, projected name/description/
  links), and which files it ABSTAINS on (runtime config, bundled skill
  resources, reserved wiki files). Exercises every recognition branch + every
  "not indexed" branch.
- **placement.json** — `placeNew` per emitted type (the inverse of recognition's
  directory routing), plus the extension/idempotence edge cases the frozen
  goldens document.
- **lint.json** — `validate()` diagnostics per type: `[]` for conformant files;
  the exact violation for the deliberate bad cases (`agent-skills` bad
  name/over-long description, `akm-task` two-targets, `dotenv` dangerous key,
  `llm-wiki` broken xref). Pins the §6/§4.5 validation columns and per-adapter
  strictness.
- **renderer.json** — the `type`-keyed presentation each type flows through. For
  `dotenv` this is the **§C.2 field-omission redaction oracle** (env → key names
  only; secret → name/path/action only, no content).

---

## 3. How expected outputs were derived (spec → golden)

The `type` derivation and validation come from the **§6 table** (the
foreign-derivation convention column + the type-specific validation column) and
the **§7 adapter table**; presentation comes from `src/core/type-presentation.ts`
(`TYPE_PRESENTATION` keyed on the open `type`, `KNOWN_TYPES`, and the
`DEFAULT_PRESENTATION` generic fallback). Concrete grounding per format:

- **claude / opencode** — type from directory + frontmatter (§6: command =
  `.md` under `commands/` + `$ARGUMENTS`/`agent` probe; agent = `.md` under
  `agents/` + `tools`/`model` probe; skill = `SKILL.md`, item = the dir;
  `CLAUDE.md`/`AGENTS.md` = instruction). `settings.json`/`.mcp.json`/`opencode.json`
  are runtime config → abstain (§7). OpenCode uses PLURAL subdirs (§7 + canonical
  OpenCode); singular is a backwards-compat alias.
- **agent-skills** — the Agent Skills contract (§4.5): hard name
  `^[a-z0-9]+(-[a-z0-9]+)*$` 1–64 == dir name; description 1–1024; `compatibility`
  ≤500; `metadata` string→string. STRICT on unknown frontmatter. Recognition ≠
  validation (invalid skills still recognize; violations surface in `validate`).
- **akm-workflow / akm-task** — native schemas (§6): workflow `.md`/`.yaml`/`.yml`
  (markdown ≈ OKF, YAML program is an AKM extension); task `.yml`
  (schedule+enabled+one target → `invalid-task-yaml`).
- **dotenv** — env `.env` (key NAMES only, values never indexed) + secret (file
  name only). Redaction keyed on the ADAPTER, never the type (§2, normative
  §21.2). Dangerous-key scan on `*.env` only (`dangerous-vault-key`).
- **website-snapshot** — read-only crawl snapshot; pages re-typed to `website`
  (§6/§7). On-disk shape from `src/sources/website-ingest.ts`.
- **generic-files** — document/script/file; explicit-config only, never
  auto-probed (§1.2).
- **llm-wiki** — reserved `schema/index/log`; `raw/` sources; `pages/**` typed by
  `pageKind`; xrefs/citations → links; native wiki validation (§6/§7, §0.2, §9).

Where the spec names a **rule** but not a diagnostic **code** (the Agent Skills
field checks, the wiki checks), the code strings are **proposed, spec-aligned**
and the golden says so; the `missing-skill-md`, `dangerous-vault-key`, and
`invalid-task-yaml` codes ARE code-grounded and reused verbatim.

---

## 4. Real-world sources (cited per format, in each golden's `realWorldSource`)

- **Agent Skills** — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
  (name ≤64 lowercase/digits/hyphens, no XML tags, no reserved words
  "anthropic"/"claude"; description non-empty ≤1024; progressive disclosure
  metadata/instructions(<5k tokens)/resources) + the vendored `skills-ref`
  validator (0.1.0) per spec References + https://github.com/anthropics/skills .
  (`agentskills.io/specification` 403'd through the proxy; the platform.claude.com
  page is the authoritative equivalent.)
- **Claude Code `.claude`** — https://code.claude.com/docs/en/claude-directory
  (`CLAUDE.md` at root; `.claude/commands/*.md` with `$ARGUMENTS` + `argument-hint`/
  `allowed-tools`; `.claude/agents/*.md` with `description`/`tools`/`model`;
  `.claude/skills/<name>/SKILL.md`; `settings.json`/`.mcp.json` = config).
- **OpenCode `.opencode`** — https://opencode.ai/docs/commands/ ,
  https://opencode.ai/docs/agents/ , https://opencode.ai/docs/skills/ ,
  https://opencode.ai/docs/rules/ (plural `commands/`/`agents/`/`skills/`, singular
  backwards-compat; `AGENTS.md` = instruction; reads `.claude/skills/`;
  `opencode.json` = config). (opencode.ai 403'd through the proxy for some pages;
  the directory-plurality and frontmatter facts were confirmed via web search of
  those docs.)
- **OKF** — https://github.com/GoogleCloudPlatform/knowledge-catalog `okf/SPEC.md`
  (already covered by the DONE `okf-sample` golden; referenced for the
  reserved-file + path-identity model reused by llm-wiki).
- **dotenv** — https://www.dotenv.org/docs/security/env (KEY=VALUE, `#` comments,
  secrets never printed).
- **website snapshot** — `src/sources/website-ingest.ts` (the real on-disk writer)
  + https://example.com/ (illustrative host).
- **llm-wiki** — `src/wiki/wiki.ts` + `src/assets/wiki/*-template.md` (the akm
  LLM Wiki structure).
- **akm-workflow / akm-task / env / secret / script** — AKM-native; grounded in
  the existing codecs (`src/workflows/`, `src/tasks/`, `src/output/renderers.ts`)
  and the frozen `all-types` fixtures.

---

## 5. Open questions / ambiguities (flagged, NOT silently guessed)

Each has a recorded best-reasoned default in the golden; the adapter author
resolves it when the adapter lands.

1. **`instruction` presentation (claude/opencode).** `instruction`
   (`CLAUDE.md`/`AGENTS.md`) is a NEW type (§7) but has NO `TYPE_PRESENTATION`
   entry (not in `KNOWN_TYPES`). **Default:** generic fallback (`{label:'Asset'}`,
   `akm show <ref>`). **Open:** add an `instruction` presentation entry (e.g. a
   "read the project instructions" renderer)?
2. **llm-wiki page `type` (CENTRAL, Chunk 4).** Spec §6 says wiki pages carry
   "its own type values" and §0.2 retires the `wiki` asset-type. **Default
   (reading A):** page `type` = frontmatter `pageKind` (concept/entity/note/…),
   raw sources `type` = `wiki-source` — all render GENERICALLY (the extant
   `wiki-md` renderer goes unused). **Alternative (reading B):** emit a single
   `type` = `wiki` (reuse `wiki-md`) and carry `pageKind` as metadata — contradicts
   §0.2. Both are recorded in the recognition/renderer goldens.
3. **website-snapshot re-typing + conceptId.** On-disk pages are knowledge-shaped
   (no `type:` field, tagged `website`); the adapter re-types them to `website`.
   **Open:** is the re-type unconditional or gated on the `website` tag/`sourceUrl`?
   And does the conceptId strip the `stash/knowledge/` prefix? Both forms recorded.
4. **`website` / `document` / `file` have no presentation entries.** Generic
   fallback is the default; the adapter author may add entries.
5. **generic-files classification predicate + placement.** Spec names
   document/script/file but not the exact rules. **Default:** SCRIPT_EXTENSIONS →
   script; markdown/text → document; else → file; placement = identity (keep the
   natural path). Open for the adapter author.
6. **OpenCode singular vs plural dirs.** **Resolved to PLURAL** (spec §7 +
   canonical OpenCode); singular is a backwards-compat alias the adapter should
   also accept.
7. **Proposed diagnostic codes.** The Agent Skills field codes
   (`skill-name-invalid`, `skill-description-too-long`, `skill-unknown-frontmatter`)
   and the wiki codes (`broken-xref`, `uncited-raw`, `missing-description`,
   `orphan`) are PROPOSED — the spec names the rules, not the codes. Finalize when
   the checks are built.

---

## 6. Registration status (IMPORTANT for the integrator)

These goldens are **deliberately NOT registered** in
`tests/fixtures/goldens/DESIGNATIONS.json`, and **no consumer test is wired**
(per the task constraints: don't touch the sha256-pinned frozen registry; don't
wire a consumer test — that lands with the adapter). Consequences:

- `bun run lint` (incl. `scripts/lint-goldens-presence.ts`) stays **green**: that
  lint only validates ENTRIES already in the registry — it never scans for orphan
  golden files. Verified.
- The **`tests/goldens-designations.test.ts` meta-test WILL fail** on the full
  `bun test` suite: it requires every file under `tests/fixtures/goldens/**` to
  have exactly one registry entry. These 36 files are intentionally unregistered.
  This is BY DESIGN — the goldens "get registered/frozen when their adapter lands"
  (task constraint). It cannot be avoided while (a) the goldens live under
  `tests/fixtures/goldens/` (mandated), (b) DESIGNATIONS.json is not edited
  (mandated), and (c) no consumer test exists (mandated) — because
  `lint-goldens-presence` requires every registered entry to have a consumer.
- **When an adapter lands:** its chunk registers its four goldens in
  DESIGNATIONS.json (designation `frozen-migration-input` + sha256, or
  `re-baseline` + `reBaselineChunk`) and wires a consumer test that loads them via
  `expectGolden`/`loadGolden`. At that point the meta-test goes green and the
  goldens are frozen.

The fixture bundles under `tests/fixtures/bundles/` are NOT golden data and are
subject to no designation check.
