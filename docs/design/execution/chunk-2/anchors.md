# Chunk 2 — grounding census (anchors)

Censused at HEAD `fdff3dc24888307509ea27706b5f28db09969510` (chunk 1.5 WI-1.5.1
landed — open type token; chunk 1 fully closed per its own ledger), 2026-07-17,
by direct read-only inspection (every anchor below opened at this HEAD; none
trusted from the plan/spec text alone). Authority: manifest chunk id "2"
(scope + 3 gates + testBucket) and chunk id "1" (the `BundleAdapter` contract
it mints against, landed) and "1.5" (`KNOWN_TYPES`/`TYPE_PRESENTATION`, landed)
and "0b" (the parity goldens, landed) and "3" (deletes the globals chunk 2
replaces, not yet started); `akm-0.9.0-bundle-adapter-spec.md` §§1–7;
`akm-0.9.0-bundle-adapter-architecture-plan.md` §2.3 (capability table), §4.5
(the skill Agent Skills contract row), §11 (Chunk 2 paragraph), §12.3
(contract tests), §12.4 (risks); chunk-0b anchors.md Section B (14-format
producer inventory) and the chunk-0b goldens themselves.

**State at this HEAD, confirmed by direct probe:** `src/core/adapter/` exists
with exactly 3 files — `bundle-adapter.ts` (121 LOC), `types.ts` (171 LOC),
`scan-component.ts` (149 LOC) — landed by Chunk 1, additive only, **zero
concrete adapters implemented** (chunk-1 ledger: "No concrete adapter is
implemented here — Chunk 2 mints the first real adapters"). `src/core/
recognition-util.ts` and `src/core/type-presentation.ts` exist (Chunk 1/1.5).
The cycle-ratchet baseline is **18** (`bun scripts/lint-import-cycles.ts` at
this HEAD: "18 cycle participant(s) within baseline (18)"). All of Chunk 0b's
5 relevant goldens (`recognition/all-types.json`, `placement/all-types.json`,
`renderer/all-types.json`, `lint/all-types.json`, `minting/oracle.json`) are
present, `DESIGNATIONS.json`-registered as `frozen-migration-input` (sha256-
pinned), and their own notes fields already say "Chunk 2's format adapters
must reproduce this ... byte-for-byte." No `docs/design/execution/chunk-2/`
content existed before this census (empty dir).

---

## A. The 10-adapters ↔ 14-formats map — PROPOSED split (a decision, not a fact)

### A.1 Why this is not already answered in the docs

The manifest/plan's "10 adapters covering the 14 formats" phrase names a
**count**, not a membership list. The bundle-adapter spec's own §4 registry
(`akm-0.9.0-bundle-adapter-spec.md:267`, "Registry is a static frozen
`BUILTIN_ADAPTERS` map") lists exactly 10 ids — `okf, llm-wiki, claude,
opencode, agent-skills, akm-workflow, akm-task, dotenv, website-snapshot,
generic-files` — but this is the **aspirational target-state registry**, not
Chunk 2's scope: `llm-wiki` is explicitly Chunk 4's mint (manifest chunk id
"4": "relocate native wiki semantics ... into an llm-wiki adapter"), and
`opencode`/`website-snapshot`/`generic-files` cover formats that are not among
today's 14 legacy types at all (no `.opencode` tool dir, no website-crawl
type, no explicit-config generic-files type exists in `ASSET_SPECS_INTERNAL`
today). Conversely the spec §4 list has **no adapter at all** for 7 of the 14
legacy types individually (command/agent/knowledge/memory/lesson/session/fact
would all collapse into the pure-frontmatter `okf` adapter in the target
state — spec §5: "No directory gate (OKF §1)"). **That pure-OKF recognition
model directly conflicts with Chunk 2's own gate** ("Recognition/placement/
renderer/lint parity vs Chunk 0b goldens for all 14 formats" — the goldens
were captured from today's `DIR_TYPE_MAP` dir-hint matcher, chunk-0b anchors
§B.1). Chunk 2 cannot build the literal spec-§5 `okf` adapter and pass its own
parity gate simultaneously — dir-hint recognition must survive through Chunk 2
regardless of the aspirational end state. **This census therefore treats "10
adapters covering the 14 formats" as Chunk 2's own transitional, parity-
preserving grouping — not the spec §4 registry — and proposes one.**

### A.2 Proposed 10-adapter split

| # | Adapter id (proposed) | Type(s) owned | Why grouped |
|---|---|---|---|
| 1 | `skill` | skill | Own recognition (SKILL.md filename + dir-entry, matchers.ts:135-138,154-157,177-178), own placement (asset-spec.ts:84-93, the one dir-entry `toAssetPath`), own linter, **plus the wholly new §4.5 Agent Skills contract** (§C.1 below) |
| 2 | `wiki` | wiki | Own recognition (`classifyByWiki`, ancestor-dir rule, matchers.ts:254-260) — **transitional**: Chunk 4 replaces this adapter's identity with `llm-wiki` and kills the `wiki` type token. Chunk 2 still owes it parity now because the Chunk-0b goldens include it and Chunk 2's own gate says "all 14 formats" |
| 3 | `script` | script | Own recognition (16 `SCRIPT_EXTENSIONS`, `recognition-util.ts`), no linter, distinct `scriptSpec` placement (asset-spec.ts:77-81) |
| 4 | `workflow` | workflow | Own dual-form recognition (md content-probe + yaml program, matchers.ts:184-226,245-252), own linter, 2 renderers, `workflowSpec` placement (asset-spec.ts:37-61) |
| 5 | `task` | task | Own recognition (`.yml` under `tasks/`, matchers.ts:90-97), own YAML placement + linter |
| 6 | `dotenv` | env, secret | **Paired, not split.** `lint/index.ts:191-218`'s dangerous-key pass already scans both `env/` and `secrets/` in ONE loop via the SAME function (`checkEnvForDangerousKeys === checkVaultForDangerousKeys`, `env-key-rules.ts:200`); both are filename/dir-identity recognition (no content parse), both render by omission (redaction, §C.2), neither has a dedicated `AssetLinter`. The aspirational spec §4 registry itself has **no distinct `secret` adapter id** — only `dotenv` — which is independent corroborating evidence this pairing is the intended target shape, not just a Chunk-2 shortcut |
| 7 | `knowledge` | knowledge | Standalone despite sharing the generic dir-hint+markdownSpec mechanism with #9/#10 below, because it plays a **structurally distinct role**: the `classifyBySmartMd` fallthrough DEFAULT (matchers.ts:225, specificity 5 — every unmatched `.md` becomes `knowledge`), and the type OKF's own `okf` adapter defaults to when frontmatter `type` is absent (spec §5). Foreshadows becoming the eventual default/reference adapter |
| 8 | `agent-tooling` | command, agent | Paired: identical dir-hint+markdownSpec recognition, but more importantly **their `classifyBySmartMd` disambiguation is written as coupled sibling branches** probing overlapping frontmatter shapes (`"toolPolicy"/"tools" in fm` → agent, specificity 20; `"agent" in fm` → command, specificity 18; `"model" in fm` → agent, specificity 8 — matchers.ts:207-222) — the two types' recognition logic cannot be read independently. Mirrors the future `claude`/`opencode` adapters, which also emit command+agent+skill+instruction together from one component (spec §7) |
| 9 | `memory` | memory | Standalone: `MemoryLinter`'s `orphaned-stub` check (memory-linter.ts:59-65, `inferenceProcessed`+body-length+`.derived.md`-sibling probe) and `applyMemoryMetadata`'s richer contributor (source/observed_at/expires/subjective hints, output/renderers.ts:699-725) are genuinely more elaborate than lesson/session/fact — the most behaviorally distinct member of the generic markdown family after knowledge |
| 10 | `note` | lesson, session, fact | The "thin" remainder of the markdown family: lesson dispatches to the shared `DefaultLinter` (registry.ts:39, explicit `"lessons"` key) plus one metadata contributor (`applyLessonMetadata`); session has **no linter at all** (falls to `DefaultLinter` via the `?? DEFAULT_LINTER` fallback, registry.ts:46) and no lint-time reach in production (§D below); fact has one shallow `missing-category` check (fact-linter.ts:26-41). Grouping these three (not folding into `memory` or `knowledge`) keeps each `validate()`/`recognize()` dispatch a simple internal switch over 3 near-identical branches |

**Total: 10 adapters, 14 types** (1+1+1+1+1+2+1+2+1+3). Rejected alternatives
considered and why: (a) splitting `command`/`agent` into 2 separate adapters
and merging `env`/`secret` differently would also total 10 but loses the
`dotenv` pairing's strong evidentiary basis (§4's registry, the shared
dangerous-key loop); (b) collapsing the whole markdown family (knowledge/
command/agent/memory/lesson/session/fact, 7 types) into 1-2 adapters is
mechanically defensible (all 7 share the exact same `parentDirHintMatcher`/
`markdownSpec` machinery) but produces 6-7 total adapters, not 10, and buries
memory's genuinely distinct validate logic inside a generic dispatcher.
**This split is a proposal for maintainer sign-off, not a discovered fact —
flag prominently.**

---

## B. Per-adapter: current logic each `BundleAdapter` method must reproduce

`BundleAdapter` members, this HEAD: `src/core/adapter/bundle-adapter.ts:69-121`
(`recognize`/`validate` REQUIRED; `index`/`affectedItems`/`placeNew`/
`directoryList`/`looksLikeRoot` OPTIONAL). Capability→replaces mapping per
plan §2.3 table, `akm-0.9.0-bundle-adapter-architecture-plan.md:76-90`.

### B.1 `recognize` — matcher + metadata-contributor sources, by adapter

| Adapter | Matcher logic (file:line) | Metadata contributor(s) to fold in (file:line) |
|---|---|---|
| skill | `classifyByExtension` (SKILL.md filename, not under `wikis`) matchers.ts:154-157; `matchDirectoryHint` skill special-case matchers.ts:135-138; `classifyByParentDirHint` skill special-case matchers.ts:177-178 | none (no skill-specific contributor exists today) |
| wiki | `classifyByWiki` matchers.ts:254-260 (ancestor `wikis` dir, `.md`, idx+1 check) | `toc-metadata` output/renderers.ts:781-785 — **shared with knowledge** (`appliesTo: rendererName === "knowledge-md" \|\| "wiki-md"`), a dual-target contributor (§C.4) |
| script | `classifyByExtension` (`SCRIPT_EXTENSIONS.has(ext)`) matchers.ts:159-161; dir-hint rule matchers.ts:43-46 | `script-comment-metadata` output/renderers.ts:798-802 → `applyScriptMetadata` :726-734 |
| workflow | dir-hint `.md` matchers.ts:62-66; `looksLikeWorkflow` body probe inside `classifyBySmartMd` matchers.ts:200-203; `classifyByWorkflowProgram` for `.yaml`/`.yml` matchers.ts:245-252 | `workflow-document-metadata` workflows/renderer.ts:129-153 (workflow-md) + `workflow-program-metadata` workflows/renderer.ts:155-~178 (workflow-program-yaml) — **NOT in the "9" count** (§C.4) |
| task | dir-hint `.yml` matchers.ts:90-97 | `task-yaml-metadata` output/renderers.ts:816-820 → `applyTaskMetadata` :764-780 |
| dotenv (env) | dir-hint filename `.env`/`*.env` matchers.ts:77-81 | `env-file-metadata` output/renderers.ts:804-808 → `applyEnvMetadata` :736-744 |
| dotenv (secret) | dir-hint filename (any file except `.lock`/`.sensitive`) matchers.ts:82-89; `classifyBySmartMd` bail on `secrets/` matchers.ts:191 | `secret-file-metadata` output/renderers.ts:810-814 → `applySecretMetadata` :750-752 |
| knowledge | dir-hint `.md` matchers.ts:57-61; **the `classifyBySmartMd` fallthrough default** matchers.ts:225 (specificity 5, catch-all) | `toc-metadata` (shared with wiki, above) |
| agent-tooling (command) | dir-hint `.md` matchers.ts:47-51; `classifyBySmartMd` `"agent" in fm`→18 :212-214, `COMMAND_PLACEHOLDER_RE` body probe→18 :217-219 | none |
| agent-tooling (agent) | dir-hint `.md` matchers.ts:52-56; `classifyBySmartMd` `"toolPolicy"/"tools" in fm`→20 :208-210, `"model" in fm`→8 :221-223 | none |
| memory | dir-hint `.md` matchers.ts:67-71 | `memory-frontmatter-metadata` output/renderers.ts:792-796 → `applyMemoryMetadata` :699-725 |
| note (lesson) | dir-hint `.md` matchers.ts:72-76 | `lesson-frontmatter-metadata` output/renderers.ts:786-790 → `applyLessonMetadata` :686-698 |
| note (session) | dir-hint `.md` matchers.ts:99-105 (`#561` nested-path comment) | `session-md-metadata` output/renderers.ts:822-826 → `applySessionMetadata` :608-625 |
| note (fact) | dir-hint `.md` matchers.ts:107-115 | `fact-md-metadata` output/renderers.ts:828-832 → `applyFactMetadata` :642-661 |

All dir-hint rules share `matchDirectoryHint`/`DIR_TYPE_MAP` (matchers.ts:41-
152) plus the `isTypedDirDocFile`/`TYPED_DIR_DOC_FILES` README.md exclusion
(:120-129) and the specificity ladder (`classifyByDirectory` walks
`ancestorDirs` at specificity 10, `classifyByParentDirHint` checks the
immediate parent at specificity 15) — every dir-hint-based adapter's
`recognize` must reproduce BOTH specificity levels, not just the immediate-
parent case, or nested paths (e.g. `facts/<category>/<name>.md`,
`sessions/<harness>/<id>.md` — the two rules with an explicit nested-path
comment, matchers.ts:98-102,107-111) misclassify. `toMatchResult` (matchers.ts
:266-277) is the `MatchFact→MatchResult` adapter shim that looks up the
renderer name via `defaultRendererRegistry.rendererNameFor` — this indirection
disappears once each adapter names its own renderer directly (§B.4).

### B.2 The 9 index-time metadata contributors — full enumeration

Confirmed by `grep registerMetadataContributor` at this HEAD: **11 call sites
total** codebase-wide — 9 in `output/renderers.ts` (the manifest's "9" figure
is scoped precisely to this file) + 2 in `workflows/renderer.ts` (owned by the
workflow adapter regardless, so not double-counted against the "9"):

| # | Name | file:line | Applies to (rendererName) | Lands in adapter |
|---|---|---|---|---|
| 1 | `toc-metadata` | output/renderers.ts:781-785 | `knowledge-md` **or** `wiki-md` (dual-target) | knowledge AND wiki (§C.4) |
| 2 | `lesson-frontmatter-metadata` | output/renderers.ts:786-790 | `lesson-md` | note |
| 3 | `memory-frontmatter-metadata` | output/renderers.ts:792-796 | `memory-md` | memory |
| 4 | `script-comment-metadata` | output/renderers.ts:798-802 | `script-source` | script |
| 5 | `env-file-metadata` | output/renderers.ts:804-808 | `env-file` | dotenv |
| 6 | `secret-file-metadata` | output/renderers.ts:810-814 | `secret-file` | dotenv |
| 7 | `task-yaml-metadata` | output/renderers.ts:816-820 | `task-yaml` | task |
| 8 | `session-md-metadata` | output/renderers.ts:822-826 | `session-md` | note |
| 9 | `fact-md-metadata` | output/renderers.ts:828-832 | `fact-md` | note |
| (10) | `workflow-document-metadata` | workflows/renderer.ts:129-153 | `workflow-md` | workflow (not in the "9") |
| (11) | `workflow-program-metadata` | workflows/renderer.ts:155-~178 | `workflow-program-yaml` | workflow (not in the "9") |

Note: knowledge/command/agent have **no** dedicated contributor beyond the
shared `applyFrontmatterDescriptionAndTags` helper (output/renderers.ts:668-
684) each renderer's `buildShowResponse` calls inline — that helper's
description/tags-merge logic must be preserved inside `recognize`'s
`IndexDocument` construction for knowledge/command/agent/wiki (wherever it's
currently reached indirectly), not just the 9(+2) explicitly-registered
contributors.

### B.3 `placeNew` ← `toAssetPath`/`resolveAssetPathFromName`

| Adapter | Placement spec (file:line) | Notes |
|---|---|---|
| skill | asset-spec.ts:84-93 | `<typeRoot>/<name>/SKILL.md` — the one dir-entry form |
| wiki | asset-spec.ts:151-156 (`...markdownSpec`) | same as generic markdown |
| script | `scriptSpec` asset-spec.ts:77-81 | keeps extension in the name (unlike markdownSpec) |
| workflow | `workflowSpec` asset-spec.ts:37-61 | multi-extension probe: explicit ext wins, else `fs.existsSync` candidate probe in priority order, else `.md` fallback — **the only placement spec that touches disk** |
| task | asset-spec.ts:169-186 | `.yml`, strips/adds `.yml` |
| dotenv (env) | asset-spec.ts:108-133 | `.env`→`default` alias; `<name>.env`→`<name>` |
| dotenv (secret) | asset-spec.ts:134-150 | identity path join, no extension logic |
| knowledge/agent-tooling/memory/note | `markdownSpec` asset-spec.ts:63-75 | shared verbatim: accepts with/without `.md` |

`resolveAssetPathFromName` (asset-spec.ts:309-313) is the dispatcher chunk 3
deletes; each adapter's `placeNew(c, conceptId)` inlines its own spec's
`toAssetPath` logic directly (no shared dispatcher needed post-port).

### B.4 `directoryList` ← `TYPE_DIRS[type]`

`TYPE_DIRS` (asset-spec.ts:280-282) is a flat `Record<type,stashDir>`
derived from `ASSET_SPECS_INTERNAL`. Per-adapter `directoryList()` is a
1-2 element literal array: skill→`["skills"]`, wiki→`["wikis"]`,
script→`["scripts"]`, workflow→`["workflows"]`, task→`["tasks"]`,
dotenv→`["env","secrets"]`, knowledge→`["knowledge"]`,
agent-tooling→`["commands","agents"]`, memory→`["memories"]`,
note→`["lessons","sessions","facts"]`. This feeds git exact-path staging
(`git-stash.ts:241`, per plan §2.3 table) and (per manifest chunk 3, NOT
chunk 2) `provider-utils.detectStashRoot`/`git-provider.hasExtractedRepo`
(§F.3 below) — chunk 2 only **mints** `directoryList()`; wiring it into those
call sites is explicitly Chunk 3's job.

### B.5 `validate` ← the type's linter, adapted to `(c, changes, ctx) => Promise<Diagnostic[]>`

| Adapter | Linter class (file:line) | Extra checks beyond base | In production `akm lint` today? |
|---|---|---|---|
| skill | `SkillLinter` lint/skill-linter.ts:24-50 | `missing-skill-md` (dir-level, :31-45) + base | yes (`STASH_SUBDIRS` includes `skills`) |
| wiki | none — `DefaultLinter` fallback | — | **no** — not in `STASH_SUBDIRS` (§D below) |
| script | none — `DefaultLinter` fallback | — | **no** |
| workflow | `WorkflowLinter` lint/workflow-linter.ts:19-87 | `placeholder-stub` (:81-86, deletes file on `--fix`) + `invalid-workflow-structure` via `parseWorkflow` (:56-76) | yes, **markdown form only** — `.yaml`/`.yml` never reaches `WorkflowLinter` in production (`collectMarkdownFiles` filters `.md` only); its only correctness surface is `parseWorkflowProgram`'s own result (chunk-0b lint golden note) |
| task | `TaskLinter` lint/task-linter.ts:22-60 | `invalid-task-yaml`: schedule (non-empty string) + enabled (boolean) + ≥1 of prompt/workflow/command (:30-56) | yes |
| dotenv (env) | none — `DefaultLinter` fallback for base checks; **PLUS** the separate dangerous-key pass `lint/index.ts:191-218` → `checkEnvForDangerousKeys` (`env-key-rules.ts:200`, alias of `checkVaultForDangerousKeys` :166-183) | `dangerous-vault-key` warn, scoped to `.env`-suffixed files only (`collectEnvFiles`) | **partially** — the dangerous-key pass runs (scans `env/`), base-check linter does not (env dir not in `STASH_SUBDIRS`) |
| dotenv (secret) | same dangerous-key pass, `scanSubdir:"secrets"` branch (`lint/index.ts:201-204`) | same, filtered to `.env`-suffixed filenames — misses the common case (a bare-named secret file) | **partially, narrowly** — reaches `secrets/*.env` only, not bare-named secret files (confirmed against the all-types fixture: `secrets/all-types-secret` is unreached) |
| knowledge | `KnowledgeLinter` lint/knowledge-linter.ts:14-20 | none beyond base | yes |
| agent-tooling (command) | `CommandLinter` lint/command-linter.ts:20-50 | `missing-name-or-type` (missing OR invalid `type` value) | yes |
| agent-tooling (agent) | `AgentLinter` lint/agent-linter.ts:20-50 | same shape, `VALID_AGENT_TYPES=["agent"]` | yes |
| memory | `MemoryLinter` lint/memory-linter.ts:16-66 | `orphaned-stub`: `inferenceProcessed===true` + body <100 chars + no `.derived.md` sibling → delete on `--fix` (:59-65) | yes |
| note (lesson) | `DefaultLinter`, **explicitly keyed** `LINTER_MAP.set("lessons", DEFAULT_LINTER)` registry.ts:39 | none beyond base | yes |
| note (session) | none — `DefaultLinter` fallback | — | **no** |
| note (fact) | `FactLinter` lint/fact-linter.ts:20-45 | `missing-category` (empty or not in `KNOWN_CATEGORIES`) | yes |

**Base checks** (`unquoted-colon`, `missing-updated`, `stale-path`,
`missing-ref`) live in `BaseLinter.runBaseChecks` (base-linter.ts:583-~735,
every non-`DefaultLinter` class extends `BaseLinter`). `missing-ref` (:675-
731) resolves `<type>:<slug>` refs via `REF_RE` built from `getAssetTypes()`
(asset-registry-derived type alternation, base-linter.ts:142-183) — this is
exactly the check the new interface's own doc comment calls out as core-owned
("Cross-component ref existence is a CORE base check, not an adapter
concern," `bundle-adapter.ts:99-100`) and maps to `ValidateContext.resolveRef`
(`types.ts:154`). **Design implication for the brief:** `runBaseChecks`'s
4 checks split into (a) a shared CORE helper every adapter's `validate()`
calls (unquoted-colon/missing-updated/stale-path locally, missing-ref via
`ctx.resolveRef`), and (b) the per-type extra checks in the table above that
move into each adapter's own `validate()` body — not a wholesale per-adapter
reimplementation of all 4 base checks.

### B.6 `presentation` ← renderer + `TYPE_PRESENTATION`

Renderer bodies: `output/renderers.ts` (skillMdRenderer :205-222,
commandMdRenderer :226-247, agentMdRenderer :251-272, `buildMarkdownViewResponse`
shared knowledge/wiki helper :287-319, knowledgeMdRenderer :323-329,
wikiMdRenderer :333-339, lessonMdRenderer :353-373, memoryMdRenderer :377-390,
scriptSourceRenderer :397-442, envFileRenderer :451-471, secretFileRenderer
:480-493, taskMdRenderer :500-513, sessionMdRenderer :525-564, factMdRenderer
:576-606) + `workflows/renderer.ts` (workflowMdRenderer :63-88,
workflowProgramRenderer :98-127). `TYPE_PRESENTATION` (typed `{label}` only,
`src/core/type-presentation.ts:39-54`, Chunk 1.5) is explicitly the durable
home Chunk 2/3 extend with real renderer/action wiring — its own file header
says so (:16-22): "`label` is the only field minted now; Chunk 2/3 own
extending this shape with real renderer/action wiring."

**6 static-only renderer mappings** (chunk-0b anchors §B.2, cross-confirmed
against spec §6 line 305 "6 renderer mappings ... script/skill/command/agent/
knowledge/memory ... live only in `TYPE_PRESENTATION`"): these 6 types carry
NO `rendererName`/`actionBuilder` in `asset-spec.ts`'s `ASSET_SPECS_INTERNAL`
— only `asset-registry.ts`'s static `TYPE_TO_RENDERER`/`ACTION_BUILDERS`
(:21-58) name them. The other 8 (workflow/env/secret/wiki/lesson/task/
session/fact) carry `rendererName`/`actionBuilder` directly in their
`asset-spec.ts` entry (line numbers in chunk-0b anchors §B.2). **Both sources
must be ported** — losing the 6 static-only entries silently breaks
`akm show`/search-hit rendering for script/skill/command/agent/knowledge/
memory, since nothing else names their renderer.

### B.7 `looksLikeRoot` ← install-time root probe (does not exist per-adapter today)

**No per-adapter install-time probe exists anywhere in `src/` at this HEAD.**
The two existing install-time recognition sites are both coarse, ALL-14-
types-combined checks, not per-type:

| Site | file:line | Logic |
|---|---|---|
| `detectStashRoot` | `src/sources/providers/provider-utils.ts:33-49` | `.stash` marker dir, OR `hasStashDirs(root)` (any `TYPE_DIRS` value present as a subdir), OR shallowest-BFS fallback |
| `hasExtractedRepo` | `src/sources/providers/git-provider.ts:178-190` | `content/` subdir present, OR `Object.values(TYPE_DIRS).some(dirName => fs.existsSync(...))` — same "any type dir" test |

Both are keyed on the **union** of all `TYPE_DIRS` names — there is no
existing concept of "this root looks like a skill root specifically." Per-
adapter `looksLikeRoot(root)` is therefore **new logic to design, not a port**
— the natural, mechanical definition is `directoryList().some(dir =>
fs.existsSync(path.join(root, dir)))`, which trivially satisfies the Chunk 2
conformance gate ("fires on its own golden root and no sibling's") as long as
golden roots are constructed to contain ONLY one adapter's directories. No
such golden roots exist yet — Chunk 2 must build them (§D.2). Wiring
`looksLikeRoot`/`directoryList` into `detectStashRoot`/`hasExtractedRepo` is
explicitly **Chunk 3's** job (manifest chunk id "3": "WIRE adapter
`directoryList()` into git-stash pathspecs AND provider-utils.detectStashRoot/
git-provider.hasExtractedRepo BEFORE the deletions land"), not Chunk 2's.

---

## C. Special cases needing decisions

### C.1 Skill adapter — the Agent Skills contract (§4.5) is wholly new code

Plan §4.5 row (`akm-0.9.0-bundle-adapter-architecture-plan.md:226`): "ADD |
Skill adapter `validate`: Agent Skills contract — hard: name 1–64
(`^[a-z0-9]+(-[a-z0-9]+)*$`, == dir name), desc 1–1024, compatibility ≤500,
metadata string-map; warnings: body <500 lines, lowercase `skill.md`; per-
adapter unknown-field strictness (adapter spec §6) — genuinely new, small |
— | +?" Cross-confirmed against spec §6 skill row (`akm-0.9.0-bundle-adapter-
spec.md:294`) and the References section's fuller citation (:402, Agent
Skills spec at agentskills.io/specification, "pin behavior by vendoring the
`skills-ref` validator rules, currently 0.1.0").

**Grep-confirmed at this HEAD: none of this exists today.**
`SkillLinter` (lint/skill-linter.ts:24-50) checks ONLY `missing-skill-md`
(directory-level) + base checks — no name-format regex, no description-length
check, no `compatibility` field, no `metadata` string-map validation, no
body-line-count warning, no lowercase-filename warning. `grep -rn "skills-ref"
src/` → 0 hits; no vendored Agent Skills validator exists anywhere. The skill
renderer (`skillMdRenderer`, output/renderers.ts:205-222) reads only
`description`+`tags`, nothing about name/compatibility/metadata. **This is
the one piece of Chunk 2 that is net-new feature work per the spec text
itself ("genuinely new"), not a port** — the brief must scope it as new-code
authorship against the spec's hard/soft rule list, with no existing
implementation to diff against (contrast every other adapter, which is purely
a port of existing matcher/spec/linter/renderer logic).

### C.2 env/secret redaction — shape-level omission, not text-scrubbing

**Two distinct "redaction" mechanisms exist in this codebase; only one is
what §1.3/the manifest mean by "env/secret redaction renderers."**

1. **Asset-presentation redaction (the one Chunk 2 ports)** — structural
   field omission in the renderer's return shape, not scrubbing of matched
   text:
   - `envFileRenderer.buildShowResponse` (output/renderers.ts:454-465)
     returns ONLY `keys` (via `listVaultKeys`, `src/commands/env/env.ts`) —
     never file content, never comment text (the file header comment at
     :446-450 explains why: "comments routinely contain commented-out
     credentials").
   - `secretFileRenderer.buildShowResponse` (output/renderers.ts:483-492)
     returns ONLY `name`+`path`+a usage-hint `action` string — no `content`,
     no `keys`, nothing else. No `enrichSearchHit` at all (secrets are
     "discoverable by name alone," comment at :477-478).
   - `applyEnvMetadata` (:736-744) / `applySecretMetadata` (:750-752) mirror
     this at index time: env's `searchHints` gets key names only; secret gets
     tags only (`["secret","sensitive"]`), body **never** read.
2. **General-purpose text/value redaction (unrelated, NOT this chunk's
   concern)** — `src/core/redaction.ts:311-361` (`redactSensitiveText`/
   `redactSensitiveValue`), consumed by LLM client output, workflow exec
   reports, improve/proposal error messages, agent-run dispatch results. This
   scrubs KNOWN sensitive VALUES (secrets already resolved into memory) out
   of arbitrary strings before they cross an output boundary — a completely
   different mechanism from the show-renderer's field-omission-by-design.
   Chunk 2 must not conflate the two; `§1.3`'s "no new trust machinery" applies
   to (1), and (1) alone is what the adapter-keyed `presentation` must
   reproduce byte-for-byte against the renderer golden.

Porting requirement: the `dotenv` adapter's `presentation` for env/secret
must literally reproduce (1)'s shape (never add a `content`/`template`/
`prompt` field, never call `redactSensitiveText` — that would be new
machinery, not a port) — the renderer golden (`tests/fixtures/goldens/
renderer/all-types.json`) pins the exact key set each type's show-response
carries.

### C.3 workflow's two forms — one adapter, two recognize paths, two renderers

Confirmed one adapter must own both: `classifyBySmartMd`'s `looksLikeWorkflow`
body probe (matchers.ts:200-203, specificity 19) for the markdown form, and
the dedicated `classifyByWorkflowProgram` (matchers.ts:245-252) for
`.yaml`/`.yml` — the latter does NOT go through `toMatchResult`/
`rendererNameFor`; it names `WORKFLOW_PROGRAM_RENDERER_NAME` directly on its
`MatchResult` (matchers.ts:307, constant at `workflows/program/project.ts:26`
= `"workflow-program-yaml"`). Two renderers (`workflowMdRenderer` :63-88,
`workflowProgramRenderer` :98-127, both `workflows/renderer.ts`), two
metadata contributors (§B.2), one linter (`WorkflowLinter`, markdown-only
reach in production — YAML programs are correctness-checked via
`parseWorkflowProgram`'s own result, not a lint path — chunk-0b lint golden
note, cross-confirmed at `tests/fixtures/goldens/lint/all-types.json`'s
`workflowProgramYaml.correctnessCheck: "parseWorkflowProgram"` entry).

### C.4 A dual-target contributor and two contributors outside the "9"

`toc-metadata` (output/renderers.ts:781-785) applies to **both**
`knowledge-md` and `wiki-md` (`appliesTo: ({rendererName}) => rendererName
=== "knowledge-md" || rendererName === "wiki-md"`) — a single contributor
spanning two different proposed adapters (#7 knowledge, #2 wiki). Each
adapter's `recognize` must independently call the SAME `applyTocMetadata`
logic (parseMarkdownToc + headings), not silently drop the wiki side or
duplicate-diverge it. Separately, `workflow-document-metadata`/`workflow-
program-metadata` (workflows/renderer.ts:129-153,155-~178) are real
`registerMetadataContributor` call sites the manifest's "9" figure does NOT
count (scoped to `output/renderers.ts` only) — they belong to the workflow
adapter regardless and must not be missed just because they're not in the
"9."

### C.5 Base checks vs per-type checks — the split `validate()` must make

See §B.5's design-implication paragraph: `BaseLinter.runBaseChecks` bundles 4
checks (unquoted-colon, missing-updated, stale-path, missing-ref) that
EVERY non-`DefaultLinter` adapter currently inherits verbatim. `missing-ref`
specifically resolves refs against the live asset registry (`REF_RE` built
from `getAssetTypes()`, base-linter.ts:142-183) — this is the exact "cross-
component ref existence is a CORE base check" the new interface's own doc
comment reserves for the core (`bundle-adapter.ts:99-100`), feeding
`ValidateContext.resolveRef` (`types.ts:154`). **Decision needed:** does each
adapter's `validate()` call a shared core `runBaseChecks`-equivalent helper
(preserving today's byte-for-byte output including `missing-ref`'s call
shape), or does `missing-ref` become a core-level pass BundleAdapter.validate
never sees directly? The lint golden's `perType` entries (§D/E below) pin the
combined output either way — whichever design is chosen must still produce
identical `Diagnostic[]` content for the golden's frozen assertions.

---

## D. The conformance suite (gate 1, §12.3/§15.7)

### D.1 `index() == fold(recognize())` — which adapters would override `index()`?

**None of the 10 proposed adapters need to override `index()`.** The spec's
own rationale for `index?()` is "non-per-file layouts (website snapshots,
llm-wiki multi-file semantics)" (`bundle-adapter.ts:80-84`, transcribed from
spec §2) — both named examples are **out of Chunk 2's scope** (website-
snapshot is not one of the 14 legacy types; llm-wiki is Chunk 4's mint). Every
one of Chunk 2's 10 adapters is a pure per-file `recognize` walk (even skill,
whose item happens to be directory-scoped for incrementality purposes via
`affectedItems`, still recognizes per-file: one `SKILL.md` = one document).
**Conformance gate D.1 therefore has a vacuous-true shape for Chunk 2's 10
adapters** — the test still needs to exist (§12.3 gate text is unconditional:
"for adapters overriding `index()`"), but it may find zero adapters to check
against, which the brief should state explicitly rather than let read as an
oversight.

### D.2 `looksLikeRoot` fires on its own golden root and no sibling's — golden roots don't exist yet

Per §B.7, no per-adapter root-probe concept exists today, so **no per-adapter
golden root fixture exists either.** `tests/fixtures/stashes/all-types/` (the
Chunk 0b fixture, MANIFEST.json + 15 files across all 14 types in ONE
combined stash) is the wrong shape for this gate — a combined stash would
make every adapter's naive `directoryList()`-presence probe fire
simultaneously (it contains all 14 types' directories at once), which is the
opposite of what "no sibling's" must prove. **Chunk 2 must construct new,
minimal, single-adapter-only root fixtures** (e.g. a root containing only
`skills/<name>/SKILL.md` and nothing else, to prove the skill adapter's
`looksLikeRoot` fires but none of the other 9 do) — this is new fixture work,
not a golden replay, and should be sized into the work-item estimate.

### D.3 How `scanComponent` (Chunk 1) ties in

`scanComponent(inst, c, adapter)` (`src/core/adapter/scan-component.ts:136-
149`) is the core walk × `adapter.recognize` fold — already built and tested
against a stub adapter in Chunk 1 (`tests/core/adapter/scan-component.test.ts`,
9 cases incl. nested-root subtraction). Chunk 2's conformance suite is the
**first time real adapters exercise this walk** — the gate is really "wire
each of the 10 real `recognize` implementations through the existing
`scanComponent`, confirm the resulting `IndexDocument` stream matches
`recognize()` called directly per file (trivially true for non-`index()`-
overriding adapters, §D.1) and matches the recognition/placement/renderer/
lint goldens (§E)." No new `scanComponent` logic is needed; Chunk 2 is a
consumer of Chunk 1's contract, not a modifier of it.

---

## E. Parity mechanics (gates 2/3) — golden → adapter map

All 5 relevant Chunk-0b goldens are `frozen-migration-input` (sha256-pinned,
`DESIGNATIONS.json:354-388`), each with a notes field that already says
"Chunk 2's format adapters must reproduce this ... byte-for-byte":

| Golden | file | Consumer test | What it pins |
|---|---|---|---|
| Recognition | `tests/fixtures/goldens/recognition/all-types.json` | `tests/integration/goldens-recognition-placement.test.ts` | `runMatchers(buildFileContext(...))` result (type/specificity/renderer/meta) for all 15 fixture files (14 types + the workflow-program-yaml form) |
| Placement | `tests/fixtures/goldens/placement/all-types.json` | same test file | `ASSET_SPECS[type].toAssetPath(typeRoot, name)` round-tripped against the fixture layout, incl. documented edge branches (env `default` alias, workflow's multi-extension `fs.existsSync` probe, secret's nested-name join) |
| Renderer | `tests/fixtures/goldens/renderer/all-types.json` | `tests/integration/goldens-renderer-output.test.ts` | `AssetRenderer.buildShowResponse` output per type; pins 2 documented cross-renderer asymmetries (skill/command/agent/lesson/fact/session strip frontmatter, memory-md/knowledge-md/wiki-md's "full" view keeps the fence; workflow-md derives step title from heading vs workflow-program-yaml falls back to step id) |
| Lint | `tests/fixtures/goldens/lint/all-types.json` | `tests/integration/goldens-lint-output.test.ts` | BOTH `akmLintFullSweep` (real CLI entry point, 9-of-14-dirs reach) AND `perType` (direct `getLinterForType(subdir).lint(ctx)` dispatch, all 14) — §D below |
| Minting oracle | `tests/fixtures/goldens/minting/oracle.json` | `tests/integration/goldens-minting-oracle.test.ts` | `deriveCanonicalAssetNameFromStashRoot` (both canonical/fallback branches, all 14 types) + `mv-cli.ts:739`'s reject-and-steer behavior — **this one is NOT primarily Chunk 2's** (it's the frozen legacy-resolver's oracle, `migrate/legacy/legacy-layout.ts`, WI-1.4); Chunk 2's adapters' `placeNew`/canonical-naming behavior should stay CONSISTENT with it but the oracle itself is not a Chunk-2 deliverable |

### E.1 env/secret redaction parity specifically

The renderer golden's env/secret entries (`renderer/all-types.json`,
`env/all-types-env.env` and `secrets/all-types-secret` keys) pin the exact
field set §C.2 describes — the `dotenv` adapter's presentation must produce
byte-identical `ShowResponse` shapes (no extra fields, same `action` string
text verbatim, same `keys`-only/`name`-only shape). This is the manifest's
third gate stated explicitly ("env/secret redaction behavior-preserving vs
the Chunk 0b renderer goldens — port, not redesign").

### E.2 A production-reachability gap the goldens already document — do not "fix" it in Chunk 2

The lint golden's own notes field (`lint/all-types.json` scenario/notes,
cross-confirmed in `DESIGNATIONS.json:386`) documents that **`akm lint`'s
real CLI sweep never reaches script/secret/wiki/session** (`STASH_SUBDIRS`,
`lint/index.ts:37-47`, only 9 of 14 dirs) and the workflow-program-yaml form
is separately unreached (its `.md` sibling is reached, the `.yaml` file is
not — `collectMarkdownFiles` filters `.md` only). This is captured as a
**finding**, explicitly parallel to the WI-0b.1 task-matcher gap that WAS
fixed pre-Chunk-2 — but this one is captured "not a fix, per capture-only
scope." **Chunk 2 must decide, and the brief must state explicitly, whether
`validate()` being REQUIRED on every adapter (a new architectural universal)
silently "fixes" this reachability gap as a side effect** (since the core
presumably calls every adapter's `validate()` on every `FileChange`
regardless of legacy `STASH_SUBDIRS` membership) **or whether that would be a
behavior change requiring its own sign-off.** The `perType` golden entries
(direct `getLinterForType(subdir).lint(ctx)` dispatch, unconditional on
`STASH_SUBDIRS` reach) are what Chunk 2's adapters must match — those already
assume all 14 types get SOME dispatch — so the safe reading is: Chunk 2
should reproduce the `perType` results (DefaultLinter/base-checks-only output
for script/secret/wiki/session), and the "was previously unreached by the CLI
sweep" fact is preserved elsewhere (e.g. by whatever future chunk wires
`validate()` into the actual change-transaction path) — but this needs an
explicit maintainer decision, not a silent assumption either way.

---

## F. Ordering / registration / cycle

### F.1 No adapter registry exists yet — Chunk 2 must design one

Grep-confirmed: no `BUILTIN_ADAPTERS`, no `registerAdapter`, nothing
resembling an adapter registry anywhere in `src/` at this HEAD. The spec
names only the shape ("a static frozen `BUILTIN_ADAPTERS` map," §4/§12.6,
normative spec `:645-647`: "The first implementation SHOULD use a static
built-in adapter registry. A public plugin ABI is deferred"), not a file
location or exact API. **This is new scope for Chunk 2's brief to design**,
not a port. Existing precedent to model it on: `asset-registry.ts`'s
`defaultRendererRegistry` singleton pattern (`src/core/asset/asset-registry.ts
:93-100`, a plain object literal implementing a small interface,
`registerTypeRenderer`/`registerActionBuilder` as the mutation API) — a
similarly small, dependency-light singleton is the natural analog. Candidate
home: `src/core/adapter/` (alongside `bundle-adapter.ts`/`types.ts`/
`scan-component.ts`, Chunk 1's home) vs a new `src/core/adapter/adapters/`
subdirectory for the 10 implementations plus a `registry.ts` sibling. Neither
is dictated by any doc — flag as an open decision.

### F.2 Chunk 2 adds adapters ALONGSIDE the globals — no switch-over yet

Confirmed by manifest ordering: Chunk 3 ("Delete taxonomy globals") is the
NEXT chunk after Chunk 2 and is the one that deletes `matchers.ts`
competition, `asset-registry.ts`, `LINTER_MAP`+9 linters, `output/
renderers.ts` type-registry, and repoints consumers. Chunk 2's own scope text
has no deletion language at all — it only "stamps" the per-adapter methods.
**Chunk 2 therefore leaves ALL of today's globals (matchers.ts,
asset-spec.ts's registry fields, asset-registry.ts, LINTER_MAP, output/
renderers.ts) fully intact and still the live code path** — the 10 new
adapters exist as a parallel, not-yet-wired-in implementation, exercised only
by Chunk 2's own conformance/golden-replay tests, not by any production call
site (`akm show`/`akm lint`/indexing still run through the old globals until
Chunk 3 repoints them). This matters for scoping: Chunk 2's "≈ net-zero-to-
negative" netLoc figure is ADDITIVE work (new adapter files) with no matching
deletion yet — the actual net-negative only materializes once Chunk 3 deletes
the ported-from globals.

### F.3 What explicitly stays until Chunk 3

Per manifest chunk id "3" scope text verbatim: `asset-registry.ts`,
`asset-spec` registry/renderer/action fields, `matchers.ts` competition,
`file-context.ts:242-265` (`runMatchers` specificity contest), the disk-probe
in `path-resolver.ts`, `LINTER_MAP` + the 9 linter classes, `output/
renderers.ts` type-registry — **none of these are touched or deleted by
Chunk 2.** Also explicitly Chunk 3's: wiring `directoryList()` into
`git-stash.ts:241` pathspecs and `provider-utils.detectStashRoot`/
`git-provider.hasExtractedRepo` (§B.7, plan §12.4 risk paragraph). Chunk 2
mints the capability; Chunk 3 flips the switch.

### F.4 Cycle-ratchet impact — baseline 18, watch for new participants

Current baseline: **18** (verified `bun scripts/lint-import-cycles.ts` at this
HEAD: "18 cycle participant(s) within baseline (18)"). Chunk 1 already
established two precedents for `src/core/adapter/`'s import posture: a
type-only `FileContext` import (`bundle-adapter.ts:65`, erased at build time,
D1-3) and a runtime VALUE import of `walkStashFlat` (`scan-component.ts:89`,
D1-7 — flagged as a core→indexer layering wrinkle but verified cycle-safe
because nothing imports back into `src/core/adapter/` yet). **Chunk 2 changes
that precondition**: the 10 new adapter modules will need to import from
`matchers.ts` (`SCRIPT_EXTENSIONS`/`WORKFLOW_EXTENSIONS`/
`canonicalizeWorkflowName` already relocated to `core/recognition-util.ts` by
Chunk 1 — cycle-safe, import-free invariant preserved per D1-5), from
`workflows/parser.ts`/`workflows/program/parser.ts` (`looksLikeWorkflow`/
`looksLikeWorkflowProgram`, currently imported BY `matchers.ts` — a NEW
`src/core/adapter/` → `src/workflows/` edge, not previously exercised), from
`env-key-rules.ts` (dangerous-key scan, currently under `src/commands/lint/`
— a `src/core/adapter/` → `src/commands/lint/` edge), and from `redaction`-
adjacent helpers (`listVaultKeys`, `src/commands/env/env.ts`). **None of
these edges exist today** because `src/core/adapter/` currently has zero
consumers importing outward beyond `file-context`/`walker`. Each new outward
edge is a candidate NEW cycle participant if the target module (or anything
it transitively imports) ever imports back from `core/adapter/` — the brief
should audit each of these import targets before committing to the adapter's
internal module layout, since the ratchet is genuinely "no new participants
ever" (pre-armed, `scripts/lint-import-cycles.ts:189-217`), not shrink-only
tolerant of small additions.

---

## G. Headline findings + proposed work-item split

1. **"10 adapters covering the 14 formats" has no ready-made membership
   list — it must be designed, and the aspirational spec §4 registry
   (`okf`/`llm-wiki`/`claude`/`opencode`/`agent-skills`/`akm-workflow`/
   `akm-task`/`dotenv`/`website-snapshot`/`generic-files`) is NOT it.** That
   registry's own `okf` adapter (pure frontmatter-`type`, no directory gate,
   spec §5) directly conflicts with Chunk 2's own byte-for-byte parity gate
   against today's dir-hint-based Chunk-0b goldens. This census proposes a
   grounded 10-way split (§A.2) specific to Chunk 2's transitional, parity-
   preserving scope — flagged for maintainer sign-off, not a discovered fact.

2. **The skill adapter's Agent Skills contract (§4.5) is the one piece of
   Chunk 2 that is genuinely new feature work, not a port.** No existing
   code validates SKILL.md name format, description length, `compatibility`,
   or `metadata` — `SkillLinter` today only checks `missing-skill-md` + base
   checks (§C.1). Size this work item's estimate differently from the other
   9 adapters, which are pure ports.

3. **`looksLikeRoot` has no existing per-adapter analog to port from.**
   Today's only two install-time probes (`detectStashRoot`, `hasExtractedRepo`)
   are coarse "any of the 14 type dirs present" checks with zero per-type
   distinction (§B.7). Chunk 2 must both design the per-adapter predicate
   (trivial: `directoryList()`-presence) AND build NEW single-adapter golden
   root fixtures to prove the conformance gate ("fires on its own root, no
   sibling's") — the existing combined `all-types` fixture is the wrong shape
   for this (§D.2). Budget fixture construction into the estimate.

4. **A production-reachability gap the Chunk-0b lint golden already
   documents (script/secret/wiki/session unreached by `akm lint`'s real CLI
   sweep, only reachable via the golden's separate `perType` direct-dispatch
   capture) creates an ambiguity `validate()` being newly REQUIRED-on-every-
   adapter may silently resolve as a side effect.** The brief must state
   explicitly whether reproducing the `perType` golden entries (safe,
   parity-preserving) is sufficient, or whether wiring `validate()` into a
   real change-transaction path this chunk would be an unintended behavior
   change requiring separate sign-off (§E.2).

5. **Two mechanisms both called "redaction" must not be conflated.** The one
   this chunk ports is shape-level field omission in the show-renderer
   (`envFileRenderer`/`secretFileRenderer`, §C.2) — NOT `core/redaction.ts`'s
   `redactSensitiveText`/`redactSensitiveValue` (an unrelated general-purpose
   text-scrubbing utility used by LLM/workflow/improve output). Calling the
   latter from a new adapter would itself be "new trust machinery," which
   §1.3 forbids.

6. **Chunk 2 is purely additive — none of today's globals are touched.**
   `matchers.ts`, `asset-registry.ts`, `LINTER_MAP`+linters, and `output/
   renderers.ts` all stay fully live and are the ONLY production code path
   until Chunk 3 repoints consumers (§F.2/F.3). The 10 new adapters exist
   only for Chunk 2's own conformance/golden-replay tests in this chunk —
   size the "≈ net-zero-to-negative" netLoc expectation accordingly (it's
   additive-only here; the negative materializes in Chunk 3).

7. **No adapter registry mechanism exists to design against — Chunk 2 must
   invent one from a one-line spec mandate** ("a static frozen
   `BUILTIN_ADAPTERS` map," normative spec §12.6, no shape/location given).
   `asset-registry.ts`'s `defaultRendererRegistry` singleton is the closest
   existing precedent to model it on (§F.1).

8. **Cycle-ratchet risk is real and untested territory**: Chunk 1 verified
   `src/core/adapter/` cycle-safe with zero consumers importing outward
   beyond `file-context`/`walker`. Chunk 2's 10 adapters will need NEW
   outward edges (`workflows/parser.ts`, `src/commands/lint/env-key-rules.ts`,
   `src/commands/env/env.ts`) that have never been exercised from this
   directory before — each is a candidate new participant against the
   pre-armed, zero-tolerance ratchet (baseline 18, §F.4). Audit before
   committing to module layout.

### Proposed work-item split

| WI | Scope | Rationale |
|---|---|---|
| **WI-2.1** | Adapter registry + `skill`/`wiki`/`script` adapters | Establishes the registry pattern (§F.1) once; bundles the 3 adapters with the most self-contained, independent recognition logic (no cross-adapter coupling) |
| **WI-2.2** | `workflow` adapter (both forms) + `task` adapter | The two YAML-touching, dual/single-linter adapters with the most involved `validate()` logic (`parseWorkflow`/`parseWorkflowProgram` structural checks, task field checks) |
| **WI-2.3** | `dotenv` adapter (env+secret) — recognition/placement/validate/presentation | Isolated by the redaction concern (§C.2/E.1) — worth its own review pass given the "no new trust machinery" constraint and the byte-for-byte renderer-golden requirement |
| **WI-2.4** | `knowledge` + `agent-tooling` (command/agent) + `memory` + `note` (lesson/session/fact) adapters | The generic markdown family — mechanically uniform (§B.1), best done as one pass given the shared dir-hint/markdownSpec/`toc-metadata`-dual-target machinery (§C.4) |
| **WI-2.5** | Skill Agent Skills contract (§4.5, §C.1) as a standalone follow-up on top of WI-2.1's skill adapter | Genuinely new feature work (not a port) — isolate it from the port-only work so its estimate/review isn't averaged into the other 9 adapters' "just reproduce existing behavior" character |
| **WI-2.6** | Conformance suite (`index()==fold(recognize)`, `looksLikeRoot` golden-root fixtures + tests) + golden parity replay (recognition/placement/renderer/lint) across all 10 adapters + chunk close | Cross-cutting; depends on all 5 adapter work items landing first; where the §D.1 "vacuous for Chunk 2" and §D.2 "new fixtures needed" findings get resolved into actual tests |

---

**anchors.md written to `docs/design/execution/chunk-2/anchors.md`.**
