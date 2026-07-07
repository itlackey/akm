# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Workflow orchestration engine (P0 + P1 of the orchestration plan,
  experimental).** Workflows can now declare per-step orchestration —
  `### Runner`, `### Model`, `### Timeout`, `### Fan-out` (with
  `collect`/`vote` reducers), `### Schema`, `### Env`, `### Depends On`,
  and `### Route` (classify-and-dispatch: branch on a step's structured
  result, auto-skip unselected targets) —
  and be executed engine-driven with the new **`akm workflow run`**: akm
  compiles the markdown into a backend-agnostic Workflow Plan Graph IR
  (`src/workflows/ir/`), fans each step's units out through a
  semaphore-bounded scheduler (concurrency defaults to 1 per the
  local-model LLM-defaults rule, capped at `min(16, cores − 2)`; per-run
  lifetime unit cap seeded from the unit journal; per-unit timeout default
  10 m enforced on every runner including llm), validates `### Schema`
  output on every
  runner via a `runStructured` retry-with-feedback loop, resolves `### Env`
  bindings through the existing `akm env run` machinery (secret tokens,
  dangerous-key policy, keys-only audit events), and records every unit in
  the new `workflow_run_units` table (migration 004) behind a serialized
  writer queue. Every dispatched unit gets a standard akm preamble (run/unit
  ids, knowledge + env/secret + reporting contract). Steps advance strictly
  through `completeWorkflowStep`, so completion-criteria gates are never
  bypassed; unit lifecycle is observable via new
  `workflow_unit_started`/`workflow_unit_finished` events. Linear workflows
  compile and behave exactly as before. A conformance suite
  (`tests/workflows/conformance/`) pins the golden compiled plans and
  executed unit graphs so future backends (Claude Code delegation, cloud
  delegate) must reproduce them; `akm show workflow:<name>` surfaces each
  step's orchestration summary. See "Orchestrated steps" in
  `docs/features/workflows.md` and `STABILITY.md` (Experimental).
- **P2 harness adapters (orchestration plan).** Seven local coding-agent
  CLIs are now first-class dispatch targets: Codex, Copilot CLI, Pi, Gemini,
  Aider, Amazon Q, and OpenHands each get an `AgentCommandBuilder` +
  result extractor under `src/integrations/harnesses/<id>/`, registered in
  `HARNESS_REGISTRY` with the new descriptor fields (`pattern`,
  `structuredOutput`, `resume` incl. `takesSessionId`, `identityEnv` /
  `presenceEnv`, `resultExtractor`). Agent-identity detection and the
  session-log provider list are now DERIVED from the registry (no more
  hand-maintained parallel lists); presence-only flags (CODEX_SANDBOX,
  GEMINI_CLI) infer the harness but never persist as a session id.
  Harness-native unit session ids are journaled opportunistically on
  `workflow_run_units` (migration 005) for future session-reuse.
- **`fable` built-in model alias** — resolves to `claude-fable-5`
  (`opencode/claude-fable-5` on opencode); recommended resolution target for
  the `deep` workflow model tier.

### Changed

- **Workflow orchestration is now authored as a YAML program; the P1 markdown
  orchestration grammar was replaced before release (R1 of the redesign
  addendum, experimental).** The per-step markdown orchestration subsections
  listed above (`### Runner` / `### Model` / `### Timeout` / `### Fan-out` /
  `### Schema` / `### Env` / `### Depends On` / `### Route`) are **removed** —
  breaking only for the unreleased experimental surface; classic linear
  markdown workflows and the stable workflow CLI contract
  (`start`/`next`/`complete`/`status`/`list`) are untouched. Orchestrated
  workflows are instead deterministic YAML programs (`workflows/*.yaml`,
  `version: 1`) validated against a published JSON Schema
  (`schemas/akm-workflow.json`) by `akm workflow validate`; scaffold one with
  the new `akm workflow template --yaml`. R1 adds, on top of the format
  swap: **frozen per-run plans** (`workflow start` compiles and persists
  `plan_json` + `plan_hash` — migration 006, additive; a run executes the
  plan compiled at start, and edits to the source file require a new run), a
  **closed `${{ … }}` expression language** (exactly `params.<name>`,
  `steps.<id>.output.<path>`, `item`, `item_index` — parsed once into an
  AST and resolved in a single pass, so substituted content is never
  re-scanned and the P1 evidence-search/interpolation-rescan data flow is
  gone), and an **explicit failure policy** (per-unit
  `on_error: fail | continue` with fail-fast default, plus bounded
  `retry: { max, on: [<failure_reason>…] }` keyed on the persisted failure
  taxonomy). Route steps now branch on an explicit `input:` expression
  instead of an ambient evidence lookup, and route decisions are journaled
  for replay. Migration 006 also lands the run-lease columns
  (`engine_lease_until`/`engine_lease_holder`); lease enforcement, typed
  step-artifact validation, artifact-judging gates + `gate.max_loops`,
  budget/watch/worktree-isolation follow in R2. Conformance goldens are
  rewritten against YAML sources. See "Orchestrated steps" in
  `docs/features/workflows.md` and the redesign addendum in
  `docs/technical/akm-workflows-orchestration-plan.md`.
- **Workflow orchestration engine rework (R2 of the redesign addendum,
  experimental).** On top of R1's frozen plans, the engine now delivers the
  replay/determinism foundation the addendum specified. **Content-derived
  unit identity**: journaled unit ids are now
  `<step>:<sha256(canonical item)[:12]>` (`:solo` for single units), so
  cached results survive item-list reordering/regeneration, with
  **replay-divergence detection** — a journaled completed unit whose
  recorded inputs differ from the replan is a hard step failure naming the
  unit, never a silent re-dispatch (R1's positional ids were pre-release
  experimental data: no back-compat shim, old rows simply never match and
  are ignored). **Run-lease enforcement** (migration 006 columns go live):
  `workflow run` acquires a 90 s lease before any dispatch, renews it
  between steps, and releases it on exit; a second `run` on a live-leased
  run refuses up front naming the holder + expiry, an expired lease is
  claimable (crash recovery), and manual `workflow complete` is refused
  while an engine holds a live lease — the engine owns the spine while it
  drives. **Typed step artifacts**: a step's `output` schema is now
  validated against the promoted artifact before completion; a mismatch
  fails the step with the validation errors in the summary.
  **Artifact-judging gates**: engine-driven gates judge the step artifact
  (canonical JSON, clipped at 4000 chars) against the criteria instead of
  machine prose; gate evaluations are journaled as `<stepId>.gate:l<loop>`
  unit rows (human approvals are never cached). **Bounded `gate.max_loops`
  execution**: a gate rejection or artifact-schema miss re-executes the
  step's units with the judge feedback + missing criteria threaded into
  unit prompts — the feedback changes each unit's input hash, so re-runs
  dispatch fresh instead of replaying. **Run budget ceilings**: top-level
  `budget: { max_tokens?, max_units? }` in the YAML schema; counters are
  seeded from the unit journal so ceilings span resumes; hitting one aborts
  pending dispatches and fails the step hard regardless of `on_error`. New
  **`akm workflow watch <run-id>`**: run-scoped `workflow_*` /
  `workflow_unit_*` NDJSON event tail; `--stream` foreground-polls from the
  last seen event (`--interval-ms`, default 1000, no daemon) and exits at a
  terminal run status; plus an `onEvent` observability seam on `runAgent`
  (spawn start/exit, ids/status only). **`isolation: worktree`** on the
  agent AND sdk runners: each unit attempt gets a fresh detached git
  worktree under a run-scoped tmp dir, the path is journaled on the unit
  row, a clean tree is auto-removed and a dirty one retained + logged;
  non-git base dirs fail the step cleanly. Making worktrees + env work on
  the DEFAULT runner resolved SDK seam decision 1: the opencode SDK server
  is cwd-agnostic (cwd is per-call), while env bindings go through an
  env-keyed server registry — which removed the sdk `env_unsupported`
  hard-fail (llm units still reject `env` loudly). All experimental-surface
  changes; linear markdown workflows and the stable workflow CLI contract
  are untouched. See the updated "Orchestrated steps" sections in
  `docs/features/workflows.md` and `STABILITY.md` (Experimental).
- **Harness-neutral driver protocol (R3 + R4 of the redesign addendum,
  experimental).** An orchestrated run can now be driven by ANY agent
  session (Claude Code, opencode, Codex, a human at a shell), not only the
  native `akm workflow run` engine — the addendum's replacement for
  Claude-Code delegation. Two new commands: **`akm workflow brief
  <run-id|workflow:ref>`** (read-only — takes no lease, dispatches nothing,
  mutates nothing; a test proves `workflow.db` is byte-identical across a
  brief) computes the active step's expected work-list exactly as the engine
  would and emits, per unit, the content-derived `unitId`, `runner`/`model`/
  `timeout`/`retry`/`onError`, the fully-resolved instructions +
  `inputHash` (byte-identical to the engine's dispatch), the `outputSchema`,
  env binding **NAMES only** (never resolved secret values), already-journaled
  unit statuses, the gate/artifact contract, and the exact `report` command
  lines — plus a loud warning when a live engine lease is held and any stale
  claimed units; **`akm workflow report <run-id> --unit <id> --status
  completed|failed|running [--result | --result-file | stdin] [--tokens]
  [--session-id] [--failure-reason] [--note]`** is the ONE mutating verb,
  ingesting a unit's result through the SAME shared step semantics the engine
  uses. `report` refuses a non-active run and refuses while a live engine
  lease exists; validates the unit against the recomputed work-list (unknown
  id ⇒ usage error naming valid ids); computes the input hash identically to
  the engine; validates a schema unit's result against its `outputSchema`;
  treats a same-hash re-report of a COMPLETED unit as an idempotent no-op and
  a different-hash one as a hard replay-divergence error; enforces
  journal-seeded `budget.max_units`/`max_tokens` ceilings (hard step failure,
  ignoring `on_error`); and when a report makes the step's work-list fully
  terminal, runs the engine's completion path (reducer → artifact promotion
  → schema validation → artifact-judged gate → `completeWorkflowStep`),
  honoring `on_error` and `gate.max_loops` — a gate rejection with loop
  budget left leaves the step active, and the next `brief` emits loop-N's
  work-list with the judge feedback threaded into every unit prompt
  (recovered from the journaled `<stepId>.gate:l<n>` row so loop-N unit
  ids/hashes match the engine's). **Unit-level check-in**: `--status
  running` claims/heartbeats a unit (`started_at` on first claim,
  `last_checkin_at` on each heartbeat via additive **migration 007**) without
  advancing the spine; `brief`/`status` surface a claimed-but-silent unit as
  stale via a pure `now`-injectable timestamp evaluator
  (`src/workflows/runtime/unit-checkin.ts`, no daemon, mirroring the
  run-level check-in). The cardinal "no duplicated semantics" rule is
  enforced structurally: work-list computation, prompt assembly (incl.
  recovered gate feedback), route evaluation, reducer/artifact promotion,
  output-schema validation, and artifact-judged gate completion were
  extracted into ONE shared module (`src/workflows/exec/step-work.ts`) that
  `run-workflow.ts`, `brief.ts`, and `report.ts` all call — behavior for the
  engine is preserved (existing tests prove it). New passthrough output
  shapes `workflow-brief` / `workflow-report`. **R4 cross-surface
  conformance** (`tests/workflows/conformance/driver-parity.test.ts`) runs
  every golden program twice — engine-driven, then a `brief → report` loop
  over every pending unit — against identical fixture dispatch results and
  judge verdicts, and asserts the two produce IDENTICAL unit graphs (down to
  `unit_id`/`node_id`/`input_hash`/`status`/`result_json`/`failure_reason`,
  gate-evaluation rows, journaled route decisions, per-step statuses +
  artifacts, and final run status). This completes the redesign addendum
  (R1–R4); the two owner-decided permanent skips (the GitHub Copilot cloud
  delegate and the stash MCP server) were never built. All
  experimental-surface changes; linear markdown workflows and the stable
  workflow CLI contract are untouched. See "Driving a run from any agent
  (brief/report)" in `docs/features/workflows.md`, `STABILITY.md`
  (Experimental), and the redesign addendum in
  `docs/technical/akm-workflows-orchestration-plan.md`.

### Fixed

- **Check-in directives now survive plain-text output and `workflow
  status`** (check-in review C2/M1): `formatWorkflowNextPlain` and
  `formatWorkflowStatusPlain` render the `CONTINUE` directive, and every
  run-detail response (status/start/complete) evaluates the check-in instead
  of only `workflow next`.
- Workflow frontmatter validator error message now lists the actually-allowed
  keys (`name`, `updated` were missing); removed the documented-but-nonexistent
  `akm workflow step` alias from `docs/features/workflows.md`.

## [0.9.0] — 2026-06-30

### Fixed

- **improve/recombine: cap-aware decay — the `maxClustersPerRun` cap no longer
  traps recurring hypotheses below `confirmThreshold` (#658).** Recombine is a
  two-pass design: a cluster must be re-induced on `confirmThreshold` (=2) runs
  before its `type:hypothesis` proposal promotes to an auto-accepted
  `type:lesson`. But only the top-`maxClustersPerRun` (=5) clusters are
  processed per run, and `decayUnseenRecombineHypotheses` hard-reset the
  confirmation streak of every hypothesis not processed that run. A cluster that
  genuinely re-forms every run but is displaced out of the top-5 (slots are tied
  on member-count and broken by an arbitrary alphabetical tiebreak) had its
  streak zeroed — it could never win two consecutive slots, so its proposal sat
  pending forever (6 such proposals were stuck in one production stash).
  `decayUnseenRecombineHypotheses` is now **cap-aware**: `recombine.ts` passes
  the FULL pre-cap cluster set, and a hypothesis is spared from reset when its
  cluster still Jaccard-matches a present cluster (same signature, overlap ≥ 0.7
  — the same rule used for re-induction). Only hypotheses with no matching
  current cluster (the corpus stopped supporting them) decay. This does **not**
  lower the recurrence bar: the confirmation count is still advanced only by
  genuine re-induction in the processed slice (`recordRecombineInduction`);
  sparing merely avoids an artificial reset, so a genuinely non-recurring
  hypothesis still decays to 0 and never confirms (no new bland-hypothesis churn,
  cf. #632/#633). No schema change. The cap now lives in a new `capClusters`
  helper split out of `buildRelatednessClusters` so the full ranked set stays
  available for the decay sweep.
- **`improve` reflect no longer emits proposals doomed to fail the
  `invalid-description` gate when the source asset has no frontmatter
  `description` (#636).** Reflect echoed the source frontmatter, so for assets
  that carry other keys but no `description` (notably scraped docs:
  `source`/`title`/`scraped`) the proposal inherited the missing/empty
  description and the promote-time validator (`isValidDescription`, 20–400
  chars) rejected it — observed as ~14/16 rejects in one triage pass, blocking
  the whole scraped-doc/knowledge cluster from reflect improvement. The fix is
  **generation-time only**: (1) `buildReflectPrompt` now injects an explicit
  "synthesize a `description`" instruction whenever the source lacks a non-empty
  `description` and the asset type requires one (per `authoring-rules.ts`
  `DESCRIPTION_TYPES`), telling the model it MUST author a valid 20–400-char
  plain-prose description from the asset's `title:`/first `# Heading`/opening
  body; and (2) a deterministic reflect-side belt-and-suspenders in
  `sanitizeReflectPayload` — if a source that already had frontmatter still ends
  up with a missing/empty description after generation, reflect derives one
  deterministically from `title:`/first heading (validated against
  `isValidDescription`, never free-form invention) **before** the proposal is
  created. The validator, `authoring-rules.ts` bounds, `repairProposalContent`,
  and the drain are unchanged — nothing in the validator/promote path fabricates
  content to pass itself.
- **The high-salience improve admission lane (#608) now requires a
  content-derived encoding score, not the per-type weight stub (#655,
  #608/#644 follow-up).** The lane previously admitted any zero-feedback ref
  whose `asset_salience.encoding_salience >= salienceThreshold` (default 0.75).
  But for assets distill has not content-scored, `encoding_salience` is just the
  per-type WEIGHT STUB (skill/agent 0.9, command/workflow 0.8, lesson 0.75), so
  "high-salience" degenerated into "is a skill/agent/command/lesson" — which
  selected the type-stub `lore-writer` agent on every run (prod: 1 content-scored
  / 37 type-stub / 1826 NULL-legacy rows). The gate now also requires
  `isContentEncodingRow(row, parseAssetRef(ref).type)` (the #644 provenance
  helper), so only genuinely content-scored assets qualify. This preserves
  #608's intent — distilled assets, the lane's real targets, keep their real
  content score and still qualify — while cutting the type-stub waste; type-stub
  rows must earn retrieval/feedback signal via the other lanes. NULL-legacy rows
  follow `isContentEncodingRow`'s differs-from-stub heuristic. An aggregated log
  line now reports how many refs the lane admitted so lane composition is
  observable. The threshold, type-weight table, 10% cap, and `isContentEncodingRow`
  are unchanged.

- **Auto-sync no longer refuses to commit akm's own changes when unrelated
  non-akm files are present in the stash working tree.** When a stash root is
  shared with a project repo, stray files written into the stash root (e.g. a
  `tasks.bak-…` backup dir or report artifacts like `data.js`,
  `akm-health-report.html`, `reports/`) previously tripped the #476 safety
  guard, which threw `refusing to push: … has uncommitted non-akm changes` on
  **every** `akm improve` end-of-run auto-sync, `akm sync`, and `akm push`. In
  one production incident this silently blocked all commits for ~1.5 days while
  akm kept accepting proposals it never persisted. `saveGitStash` now **scopes
  what it stages** instead of refusing: (1) an explicit modified-file list when
  the caller passes `opts.paths`, else (2) the akm-managed pathspecs
  (`TYPE_DIRS` values + `.akm`) that exist on disk — which by construction never
  stages non-akm WIP, preserving the #476 protection without an all-or-nothing
  refusal — and only as a last resort (3) `git add -A` when no managed pathspec
  can be resolved. If nothing akm-managed is staged the run returns
  `nothing to commit` (no empty commit, no throw). Unrelated non-akm files are
  left untouched and uncommitted.

### Changed

- **BEHAVIOR CHANGE — `akm init --dir <path>` no longer silently repoints your
  default stash.** Previously, `akm init --dir X` unconditionally wrote
  `stashDir: X` to `config.json` whenever `X` differed from the configured
  default — so initializing a throwaway or secondary stash (e.g.
  `akm init --dir /tmp/scratch`) would hijack the user's real default stash
  pointer (the footgun documented in `memory:akm-init-persists-stashdir-warning`).
  Now `init` persists `stashDir` to config **only** when one of the following
  holds: (a) **no `--dir`** was provided (the default `~/akm` setup flow —
  unchanged), (b) `--dir` was provided and **no `stashDir` exists in config yet**
  (first-time bootstrap), or (c) `--dir` was provided **with the new
  `--set-default` flag** (explicit opt-in). Otherwise `init` still scaffolds and
  backfills the target dir exactly as before, but **leaves your default stash
  pointer untouched** and prints:
  `Your default stash is unchanged (<existing>). Re-run with --set-default to make <dir> the default.`
  The `InitResponse` JSON gains `defaultStashUpdated: boolean` and an optional
  `previousStashDir`. To make a `--dir` target your default, pass
  `akm init --dir <path> --set-default`. (`akm setup` is unaffected — it remains
  the explicit configuration flow and always sets the default.)

### Added

- **Per-type SOFT authoring conventions are now user-editable stash facts.** A
  third authoring-guidance layer joins the hard rules (#645) and general stash
  standards (#642): a stash owner can author
  `facts/conventions/assets/<type>.md` (e.g. `…/skill.md`, `…/command.md`) to
  capture soft, type-specific guidance — voice, structure, length *preference*,
  naming style. When an agent authors a `skill:x`, the body of
  `fact:conventions/assets/skill` is injected (type-scoped — authoring
  `command:y` pulls the `command` convention, never the `skill` one), labeled
  as soft guidance and kept separate from the validator-enforced hard rules.
  The basename must be a `getAssetTypes()`-validated asset type; facts are read
  straight from disk (no index rebuild) and degrade to empty safely. When no
  per-type fact exists, the built-in `TYPE_HINTS` fallback is unchanged (no
  regression). These facts carry soft conventions only and can never weaken the
  authoring contract the gate enforces (`authoringRulesForType` remains the sole
  source of validator-rejecting rules). The general convention/meta resolver now
  excludes `facts/conventions/assets/*` so per-type guidance never leaks
  un-type-scoped into other authoring flows. (#646)
- **`akm init` now seeds default per-type SOFT convention templates.** Starter
  `facts/conventions/assets/<type>.md` templates ship in the stash skeleton for
  the authored types (`lesson, skill, command, agent, knowledge, memory,
  workflow, script, fact`; `wiki`/`env`/`secret` excluded) so a stash owner has
  an editable starting point. Each expands the matching built-in `TYPE_HINTS`
  one-liner into soft starter guidance, carries `category: convention`
  frontmatter, and states in-body that it is advice, not enforced — it carries
  **no** validator-rejecting rules, so editing or deleting one cannot weaken the
  gate (#645). The stash-skeleton copy is now recursive (preserving nested
  subpaths), and `akm init` seeds **unconditionally** rather than only on first
  create: re-running it on an existing stash backfills any missing skeleton,
  convention, or `.meta/index.md` files. Seeding stays absent-only and never
  overwrites a user-edited file. (#646)

## [0.9.0-beta.36] — 2026-06-22

### Added

- **Stash standards + wiki schemas are surfaced to authoring agents at write
  time.** When an agent edits a page under `wikis/<name>/`, that wiki's
  `schema.md` body is injected into the prompt; when it creates/edits a non-wiki
  asset, the bodies of `category: convention`/`meta` `fact` assets are injected.
  Two mutually-exclusive features selected by target type, sharing one
  `standardsContext` prompt seam. Wired into reflect, propose, and every
  improve authoring pass (distill, consolidate, recombine, procedural, extract,
  schema-repair). (#642)
- **Unified, validator-sourced authoring-rules seam.** A new
  `authoringRulesForType(type)` injects the hard authoring rules (no
  pseudo-frontmatter in body, exactly two `---` fences, description/`when_to_use`
  length + shape) into every authoring prompt. The numeric bounds live in one
  module that the validators import, so the prompt can no longer drift from what
  the gate enforces. (#645)

### Fixed

- **High-salience reflect lane now reflects each asset at most once.** The
  `#608` admission gate lacked the cooldown its sibling high-retrieval gate has,
  so zero-feedback assets were re-selected on every run (auto-accept emits
  `promoted`, not `feedback`), burning LLM calls and churning assets. (#643)
- **Stuck validation-failing proposals no longer dead-end.** The triage drain no
  longer overwrites an `auto-rejected` gate stamp with a misleading
  `auto-accepted` (the failure stays truthful and visible). A bounded,
  content-preserving auto-repair (strip pseudo-frontmatter / stray `---`, repair
  truncated descriptions) runs at the promote boundary and re-validates — fixable
  proposals promote; genuinely unrepairable ones stay `pending` for manual
  review, with nothing fabricated and validation never bypassed. (#645)
- Corrected a prompt/validator drift where the distill system prompt asked for an
  80–200 char description while the gate enforced 20–400. (#645)

## [0.9.0-beta.35] — 2026-06-21

### Fixed

- **Default extract discovery window is now "since the last run" (floored at 48h),
  not a fixed 24h.** An intermittently-online host that was off for longer than
  the old 24h window could permanently miss sessions that ended during the gap.
  Discovery now looks back to the last recorded extract run for the harness, never
  less than 48h. Widening is free of redundant LLM cost — the content-hash ledger
  skips unchanged sessions with zero LLM calls. An explicit `--since`/`defaultSince`
  still wins.
- **Per-session lock prevents concurrent double-extraction.** A session-end hook
  firing `extract --session-id` while the periodic `akm improve` extract pass runs
  discovery could both LLM-process the SAME session (duplicate spend + near-dup
  proposals). A per-(harness, session) advisory lock (co-located with state.db,
  PID + age staleness recovery) now makes the second run skip without any LLM call.
- **`minNewSessions` is read from the ACTIVE improve profile, not always `default`.**
  A non-default profile (e.g. `frequent`) setting `minNewSessions` was silently
  ignored because the gate (and its candidate-count discovery window) read
  `profiles.improve.default`. They now read the resolved active profile, matching
  how `extract.enabled` already resolves.

### Docs

- Documented that `processes.extract.indexSessions` (default on) makes a second
  LLM call per processed session (the session summary); set it to `false` to halve
  per-session extract cost. Unchanged/skipped sessions still cost zero.

## [0.9.0-beta.34] — 2026-06-21

### Fixed

- **`akm extract --type opencode` reads opencode's SQLite session store.** opencode
  migrated session storage from per-file JSON (`storage/session/<projectId>/<id>.json`
  + `storage/message/<id>/*.json`) to a single Drizzle-managed database at
  `<base>/opencode.db` (tables `session`/`message`/`part`; message text lives in
  `part` rows with `data` JSON `type:"text"`). The legacy JSON layout went stale
  ~2026-02, so extract discovered 0 sessions on current opencode and the
  `session.idle` extract hook had nothing to read. `OpenCodeProvider` now prefers
  `opencode.db` when present (read-only, via the cross-driver `openDatabase` seam)
  and falls back to the JSON layout. Verified end-to-end through the plugin's
  `session.idle` hook.

## [0.9.0-beta.33] — 2026-06-21

### Fixed

- **`akm extract` decoupled from the improve-stage toggle.** `processes.extract.enabled`
  now gates extract only as a STAGE of `akm improve` (the active improve profile, per
  #593/#594); an explicit `akm extract` command always runs. Previously dropping extract
  from the daily improve profile silently disabled the standalone command (and its LLM
  calls, via the shared `session_extraction` feature gate).
- **`extract --session-id` now respects the content-hash ledger; `--force` overrides.**
  Explicit single-session extraction previously bypassed the #602 already-extracted skip
  unconditionally — re-paying the LLM on every call and risking double-extraction against
  the cron. Now a targeted `extract --session-id <id>` is idempotent (skips an unchanged,
  already-extracted session with zero LLM calls) and only `--force` re-extracts. This
  makes a session-end hook firing `extract --session-id <id>` precise AND idempotent.

## [0.9.0-beta.32] — 2026-06-21

### Added

- **Recombine acceptance path — confirmed lessons now auto-accept.** Recombine
  hypotheses that reach the confirmation threshold (promoted to `type: lesson`,
  #625/#633) now flow to ACCEPTED by reusing the existing drain mechanism instead
  of piling up pending forever: the `personal-stash` drain policy gains a
  `{ generator: "recombine", requireType: "lesson", maxDiffLines: 200 }` rule, via
  a new optional `requireType` frontmatter filter on `DrainAcceptRule`. Only
  confirmed `type: lesson` proposals auto-accept; unconfirmed `type: hypothesis`
  proposals stay pending; the existing proposal quality gate still applies.
- **`processes.reflect.lowValueFilter` (opt-in, default OFF)** — deterministic
  semantic value-floor that defers trivial reflect rewrites (#639A).
- **`processes.extract.triage.proceduralAwareFloor` (opt-in, default OFF)** —
  triage floor requiring markers/edits so real lessons always pass (#641).

### Fixed

- **Select-time proactive cooldown leak.** `selectProactiveMaintenanceRefs` plans
  the due set BEFORE acquiring `reflect-distill.lock`, so overlapping/back-to-back
  improve runs reused stale due-state and re-reflected the same asset repeatedly
  (observed up to ~16× in a day). The orchestrator now re-applies the dueDays gate
  with freshly-read timestamp maps INSIDE the lock (`filterProactiveDue`), dropping
  refs a concurrent run already reflected.

## [0.9.0-beta.31] — 2026-06-20

### Changed

- **#632 — recombine now filters junk tags structurally.** Frontmatter tags that
  are pure numbers, dates (`20260529`), short hex hashes (`002c624c`), version
  strings (`0.8.0`, `v2`), single chars, or common English stopwords (`is`, `the`,
  `for`, `when`, …) carry no topical signal and never form a recombine cluster.
  Unlike `excludeTags` (a fixed project list), this catches the OPEN-ENDED junk —
  every new date or commit hash — with no config upkeep. Exposed as `isJunkTag`.
  On the live stash this turns the recombine cluster set from generic 66–171-member
  buckets into tight topical clusters (`auth`, `architecture`, `patterns`, …).

## [0.9.0-beta.30] — 2026-06-20

### Changed / Fixed

- **#632 — recombine cluster tuning (opt-in, default-preserving).** Recombine
  clustered memories by frontmatter tag and preferred the LARGEST buckets, so it
  always picked the coarsest whole-stash tags (`session`/`claude`/`akm`, 63–171
  members) and produced bland generalizations. Two new `processes.recombine` knobs:
  `maxClusterSize` (skip clusters larger than N, so over-broad buckets no longer
  reach/starve the largest-first slice) and `excludeTags` (tags that may never form
  a tag cluster). Both UNSET = byte-identical to prior behavior.
- **#633 — recombine confirmation loop fixed.** The hypothesis confirmation streak
  was keyed on a hash of the EXACT member set, so a growing stash drifted the key
  every run → a fresh row at count 1 → `confirmThreshold` never reached → no
  hypothesis ever promoted to a lesson (a dead two-pass loop). A freshly-induced
  cluster now matches an existing pending row by signature + Jaccard
  membership-overlap (≥ 0.7) and reuses its stable ref, so the streak accumulates
  through membership drift. First/non-overlapping induction is unchanged.

## [0.9.0-beta.29] — 2026-06-20

### Reverted

- **#630 — `fact` asset type phase 2 reverted (#631).** The pinned-core assembly +
  `akm fact` CLI shipped in beta.28 was reverted pending rework. Phase 1 (#629, the
  `fact` asset type itself) remains in place.

## [0.9.0-beta.27] — 2026-06-20

All new behavior is **opt-in / default-preserving** — default runs are byte-identical.

### Added

- **#624 P2 — priority-ranked graph extraction.** `processes.graphExtraction.topN`:
  when set, the graph-extraction pass ranks eligible files by asset utility
  (`utility_scores`, read-only join) and processes only the top-N per run, so
  high-value assets get graphed first instead of a ~55h full-corpus sweep. Unset
  (default) = no ranking, byte-identical.
- **#624 P3 — lazy on-demand graph extraction.** New `graph_extraction_queue` table
  + `enqueueGraphExtraction`/`drainExtractionQueue`/`extractGraphForSingleFile`.
  `akm curate` enqueues an ungraphed hit (non-blocking); `akm show` can extract a
  missing graph inline — gated on `index.graph.lazyGraphExtraction: true`
  (**default off**: `show` makes no LLM call by default), model-guarded, and bounded
  by a 30s timeout so it never hangs. The pass drains the queue before the ranked
  sweep. This **closes #624** (all three layers shipped).
- **#616 — bounded multi-cycle phasing.** `profiles.improve.<name>.maxCycles`
  (default 1): when > 1, the improve passes run in an N-cycle loop so gate-accepted
  output of cycle N feeds cycle N+1 within the same run (re-running ensureIndex +
  ref selection each cycle), stopping at a fixed point and respecting the run budget.
  `maxCycles: 1` = byte-identical to today.

### Fixed

- **Release CI unblocked.** `runCliCapture` (test harness) restored `process.exitCode`
  to a captured `undefined`, which under `bun test` does not clear a previously-set
  non-zero exit code — so the unit suite exited 1 with 0 failures at `TEST_PARALLEL=1`
  (exactly how `release.yml` runs), silently blocking every npm publish since beta.11.
  Fixed to restore to `0`. (This is why beta.26 was the first successful workflow publish.)

### Changed

- **CI/release tests sharded across runner jobs (~15 min → ~2 min).** Bun 1.3.x
  in-process test parallelism (`--parallel=N`, N>1) hits an intermittent
  `epoll_ctl EEXIST` race / busy-spin hang on the `--isolate` workers, which had
  forced fully-sequential (`TEST_PARALLEL=1`) runs. Tests now shard across separate
  runner jobs (each a separate process tree, so no cross-shard fd/epoll collisions)
  with `--parallel=1` within each shard; the matrix runs shards concurrently. The
  release gate runs the identical set of tests. Local `bun run check` defaults to
  sequential too (the only safe mode on this Bun version). Coverage unchanged.
  Each shard runs through `scripts/run-test-shard.sh`, which retries **only on a
  hang/timeout** (the busy-spin can rarely fire even at `--parallel=1`) and never
  on a real test failure, so genuine red tests still fail fast and are never masked.

## [0.9.0-beta.26] — 2026-06-20

### Added

- **#628 — configurable SQLite journal mode (`AKM_SQLITE_JOURNAL_MODE`) for network
  filesystems.** AKM previously opened every database with `PRAGMA journal_mode = WAL`
  unconditionally, which cannot run on a network filesystem (NFS/SMB/Azure Files) —
  WAL's `-shm` shared-memory wal-index can't be `mmap`'d over a network mount. You can
  now set `AKM_SQLITE_JOURNAL_MODE` to `WAL` (default), `DELETE`, or `TRUNCATE`, applied
  at **all five** db openers (`state.db`, `index.db` ×2 paths, `workflow.db`, `logs.db`).
  At the `WAL` default AKM auto-detects a network mount for the data dir and transparently
  falls back to `DELETE` (rollback journal + `synchronous = FULL`) with a one-line warning;
  invalid values warn once and fall back to `WAL`. **Default behavior is byte-identical.**
  This lets the AKM database subtree live on a shared volume (e.g. Azure Files under
  Azure Container Apps). New docs section "Hosting AKM databases on a network share
  (NFS/SMB)" in `docs/configuration.md`.

## [0.9.0-beta.25] — 2026-06-19

Completes the recombine / extract-efficiency / graph thread. All new improve
passes are **opt-in (default off)**, so default behavior is unchanged.

### Added

- **#606 — event-driven extract (`akm extract --watch`).** Opt-in watch mode: an
  injectable, debounced watcher triggers extraction shortly after a session file
  appears, with a clean `stop()` handle. The `8,28,48` cron remains the fallback;
  no daemon is auto-launched.
- **#625 — recombine second pass (hypothesis → lesson).** The opt-in `recombine`
  process (#609) now consumes `confirmThreshold` (default 2): a generalization
  re-induced that many consecutive runs is promoted from a `type: hypothesis`
  proposal to a `type: lesson` proposal through the normal queue + quality gate
  (never a direct stash write). Hypotheses that stop recurring decay. Backed by a
  new `recombine_hypotheses` table in `state.db`.

### Changed

- **#624 (P1) — graph storage decoupled from `entries.id`.** `graph_files` is
  re-keyed on `(stash_root, file_path, body_hash)`, so extracted graph data now
  **survives a reindex** of unchanged files instead of being cascade-wiped. The
  upgrade is migrated in a **targeted, graph-only path** that preserves existing
  graph data and leaves the entry index, embeddings, FTS, and LLM-enrichment cache
  untouched — **no full index rebuild and no re-embed** on upgrade. (P2 priority-
  ranked extraction and P3 lazy/on-demand extraction remain deferred.)

### Fixed

- Graph re-key migration no longer triggers a destructive full-index rebuild: it
  is a graph-scoped table migration (no `DB_VERSION` bump), and it **copies** the
  existing graph rows into the new schema rather than dropping them.
- Test-suite `/tmp` hygiene: sandbox teardown now fires on `SIGINT`/`SIGTERM`/
  `SIGHUP` (not just clean exit), and a `sweep:tmp` step reclaims stale `akm-*`
  sandbox dirs left by force-killed workers — eliminating the tmpfs accumulation
  that caused intermittent `EEXIST: epoll_ctl` test flakes.

## [0.9.0-beta.20] — 2026-06-18

### Fixed

- **`akm update --all` no longer fails for writable `github:` entries stored as `source:"git"`**. `updateRegistryEntry` was using `synced.source` (re-derived from the ref scheme as `"github"`) instead of the existing `entry.source`, causing the config validator to reject `writable:true` on every update cycle.

## [0.9.0-beta.19] — 2026-06-17

### Fixed

- **`akm feedback` now completes in ~0.3s** (was 3+ minutes). Root cause: the command was calling `ensureIndex` with `mode: "blocking"` inside `withIndexWriterLease`, triggering a full reindex on every feedback call. Fix: removed the `ensureIndex` call entirely (feedback only needs the index to exist, not be current — a stale index is fine for ref lookup); removed the application-level writer lock (SQLite WAL + `busy_timeout=30s` handles concurrent access with `akm improve`); added a fast DB-exists guard with a clear error for first-time users.
- **`akm health --format html` now completes in ~11s** (was ~18s). Root cause: `akmHealth()` was called twice — once for the main result and once to get `deltas`. Fix: merged into a single call passing both `groupBy: "run"` and `windowCompare` together.

## [0.9.0-beta.18] — 2026-06-17

### Changed

- **Health report: Recent Runs table now shows all filtered runs in descending order** (newest first) instead of capping at the last 10.
- **Health report: Removed "Command Set Used" section.**
- **Health report: All timestamps now display in the viewer's local timezone** (chart axis labels, runs table, freshness line, executive summary, footer). Server-rendered ISO strings are wrapped in `<time data-iso>` elements and converted to local time by client-side JS on page load.

### Changed (migration required)

- **WS-2 outcome loop (#613) — default-off weight change (state.db migration 010).**
  Every `akm improve` run now writes an `asset_outcome` row per processed asset
  (state.db migration `010`) and computes a differential usefulness signal
  (`outcome_score`) per ref. The outcome signal is persisted and visible in the
  health report, but the **weight change is gated behind a config flag** (see
  below). Ranking is unchanged from WS-1 by default.

  **Opt-in weight change.** The WS-2 projection weights (`w_e=0.25, w_o=0.15,
  w_r=0.60`) affect ranking only when you explicitly set
  `improve.salience.outcomeWeightEnabled: true` in your `akm.yaml`. The default
  (`false`) keeps WS-1 parity weights (`w_e=0.30, w_r=0.70`, `w_o=0`), so
  existing users see no ranking change on upgrade.

  **Part-V measurement gate.** Before enabling the weight change, run the Part-V
  T0 baseline (`scripts/akm-eval` + `akm health`; confirm proactive accept
  ≥ 0.9× reactive; reversion ≤ 0.15; retrieval-delta ≥ 0; coverage not
  regressed). That gate requires a running production stash and cannot be
  exercised in CI. Once confirmed, set
  `improve.salience.outcomeWeightEnabled: true` to activate the three-way split.

  **Outcome loop mechanics.** `outcome_score` is a differential prediction-error
  signal: `(retrieval_delta − expected_delta) − PENALTY × retrieval_delta × (1 −
  accepted_change_rate) + valence`, tracked via an EMA (α=0.3). New rows are
  warm-started from the utility EMA score (clipped to 0.3) so the signal is
  non-zero from launch. A stash-wide diversity floor (10% of the max score) prevents
  rare-but-correct assets from being permanently outcompeted. An inverted-proxy
  tripwire (`corr(outcome_score, accepted_change_rate) < −0.3`) emits an
  `outcome_proxy_inverted` health event when the signal degrades.

  `review_pressure` is computed and persisted per asset but is **not yet wired into
  the admission policy** — that is deferred to a later work stream per plan §Part-VI
  #613. The column is present and populated; routing it into the consolidation-
  selection filter is the next step.

- **WS-1 salience vector (#618) — default-on ranking change.** The eligibility sort
  for all `akm improve` runs (whole-stash, type, and ref scope) has changed from
  `combinedEligibilityScore = utility·0.7 + negativeOnlyRatio·0.3` to
  `rankScore = (0.3·encodingSalience + 0.7·retrievalSalience) × sizePenalty`
  (feedback valence and utility EMA dropped from ordering until WS-2 re-introduces
  outcome salience). Assets are now ranked by retrieval frequency × recency × type
  importance rather than by feedback magnitude. Because the old
  `combinedEligibilityScore` ordering was never persisted, a forgetting comparison is
  not possible on the first run; instead a one-time `improve_salience_first_run` marker
  event is emitted to record the transition. On every subsequent run a stash-wide
  `improve_salience_rank_change` drift report (including `stashSize`) is emitted so
  rank movement under the new scoring can be tracked over time.
  The Part-V measurement protocol (T0 baseline via `scripts/akm-eval` + health report,
  throughput/quality gate) is deferred to the WS-2 milestone, when outcome salience
  re-joins the projection and re-tuning is triggered.

## [0.9.0-beta.12] - 2026-06-15

Improve-tuning work streams (all **default-off / parity-preserving** — no behavior
change until explicitly enabled).

### Added

- **#617 — deterministic near-duplicate memory dedup** (`processes.consolidate.dedup`,
  default off). A cheap no-LLM pre-pass in front of consolidation collapses obvious
  duplicates — `.derived`+origin pairs and content twins (normalized content-hash
  equality, or embedding cosine ≥ `cosineThreshold`, default 0.97). Each dropped
  variant is archived + backed up before deletion; hot memories are never
  collapsed; distinct-but-related memories fall through to the LLM.
- **#581 — judged-state cache for consolidation** (`processes.consolidate.judgedCache`,
  default off). New state.db table (`consolidation_judged`) records each memory's
  content hash + outcome when the LLM judges it; subsequent runs skip
  judged-unchanged memories, converting coverage from O(time-window) to
  O(changed/new) so a run can sweep the full corpus. Fails open; failed chunks
  and dry-runs never poison the cache. (state.db migration `007`.)
- **#612 — auto-accept gate calibration** (`improve.calibration`, auto-tune default
  off). Joins predicted gate confidence to realized accept/reject outcomes into a
  reliability table + calibration gap, surfaced in `akm health` (+ summary rows in
  the HTML report). Opt-in bounded threshold auto-tune nudges the accept threshold
  within a configured band toward a target accept rate, logged via a
  `calibration_autotune` event. (Replay-prioritization from prediction error is
  deferred — it depends on the #610 replay budget, a 0.10 item.)

### Fixed

- **#614 — symmetric valence weighting** (`profiles.improve.*.symmetricValence`,
  default off). The eligibility sort weighted feedback negative-only; when enabled
  it uses a symmetric `|valence|` magnitude so strong positive and strong negative
  feedback both drive attention (utility stays the dominant factor), routing
  high-negative → fix and high-positive → reinforce lanes.

## [0.9.0-beta.11] - 2026-06-15

### Added

- **`extract.maxSessionsPerRun`** (default 25) — caps the NEW sessions the
  extract pass LLM-processes in a single run so a backlog (e.g. after downtime)
  can't push one run past its scheduled-task timeout. Overflow sessions stay
  unseen and are picked up by later runs, so coverage is preserved. `0` disables.

### Fixed

- **Auto-accept validation failures are no longer a blind leak.** When a
  confidence-passing proposal fails promotion validation, the gate now captures
  the reason (the `validateProposal` finding kind, e.g. `validation:description-quality`),
  records it on the proposal (`akm proposal show` explains the rejection), logs
  it, and exposes `failedByReason` on the gate result — so the ~5% leak is
  diagnosable instead of silently warned-and-dropped.
- **Inflated skip-reason aggregates in `akm health`.** `no_new_signal` /
  `profile_filtered_all_passes` are per-run snapshots of a stable set; the
  window aggregator summed their per-run counts (≈2.7M / 3M). It now uses the
  most recent run's count for these aggregated-snapshot reasons while still
  summing genuine per-occurrence skips.

## [0.9.0-beta.10] - 2026-06-15

### Added

- **#603** — `akm health` pool-saturation advisory. Instead of alerting on the
  raw `sessionsScanned` count (which false-alarmed on normal cadence changes),
  a new `pool-saturation` advisory reports the ratio of new (unseen) sessions
  to the total session pool: informational below 10% (expected steady state),
  warning below 2% (possible discovery/dedup bug). Heuristic, never gates
  overall status.
- **#576** — the `akm health` HTML report now renders the real per-stage LLM
  token/time aggregate (a "🧠 LLM Work" KPI card + LLM token/call/wall-time
  summary rows) from the captured `llm_usage` events, replacing the GPU-time
  proxy.
- **Built-in `akm health --format html` report overhaul** — the report is now a
  strict superset of (and supersedes) the external `akm-health-report` stash
  skill. Restored the interactive filter bar (time-slice 1d–21d, task, status)
  with client-side chart/table re-render and the Last-10 "Task" column;
  reordered sections to a decision-first flow (verdict → action items → KPIs →
  table → charts); added a synthesized one-sentence **Verdict** (status + 2–3
  drivers) and a freshness line; merged the duplicate Advisories / What-to-Watch
  into one prioritized, de-duplicated **Action Items** list (P1/P2/P3 +
  remediation command); added a per-stage **LLM token** stacked-bar chart and
  `dataZoom` sliders on dense charts; fixed the failed-run scatter x-alignment
  (now shape-encoded); KPI-card colors are now health signals (not decoration);
  added metric-glossary tooltips, chart `aria-label`s, contrast fixes, and
  empty-state overlays. Deterministic output preserved.

### Fixed

- **Health report accuracy** (follow-ups to the overhaul): the per-run **Task**
  column/filter now show the real scheduled task (`akm-improve-frequent`, …) via
  a ±5min `task_history` join instead of the run's scope (which is `all` for
  every scheduled run); the time-**slice** filter options are now derived from
  the report's `--since` window (e.g. All/3d/1d/12h/6h for a 7d report) and
  default to "All" — replacing the hard-coded 1d–21d list that didn't match the
  window; and the trend **deltas** now default their compare window to `--since`
  (like-for-like, e.g. last 7d vs prior 7d) instead of a fixed 24h, which had
  produced nonsensical period-over-period percentages on multi-day reports.
- **Inflated stash-snapshot metrics in `akm health`.** `memorySummary`
  (derived/eligible) and `profileFilteredRefs` are whole-stash snapshots recorded
  on every run, but the window aggregator was **summing** them across all runs —
  e.g. "915,258 of 1,226,025 eligible" and a 2.4M filtered-ref count. They now
  take the most recent run's snapshot (the current state). Per-run *work* metrics
  (promoted, MI written, graph entities, …) remain genuine window sums.
- **Health report polish:** the akm version is stamped in the header (under the
  AKM logo) and footer; the steady-state `no new signal since last proposal`
  distill reason is excluded from the skip-reason chart (it drowned out the
  actionable reasons); and the Consolidation Output chart now draws Promoted as a
  line on a secondary right-hand axis (it dwarfs merged/deleted) with merged and
  deleted as bars on the left axis.

- **#598** — process-level tuning fields (`consolidate.incrementalSince`,
  `minPoolSize`, `neighborsPerChanged`, `extract.minContentChars`, per-process
  `enabled` flags) now survive an `akm config` rewrite. They are first-class
  typed `ImproveProcessConfigSchema` fields, so the load→save round trip no
  longer silently drops them. Unknown process sub-keys hard-error at load
  (`ConfigError`) rather than being silently discarded — the deliberate,
  documented resolution. Regression-guarded by
  `tests/config-process-roundtrip.test.ts`.

## [0.9.0-beta.9] - 2026-06-14

Restore and instrument `akm improve` steady-state output. The reflect/distill
self-improvement lanes had been near-zero in steady state because the
signal-delta eligibility gate was the only lane (cache "no-access = no-work"
pathology) and the high-retrieval fallback was structurally dead. This release
revives proactive improvement, adds attribution + a measurement/kill-criterion
system so the lane must prove its value, and right-sizes reflect budgets to
their task timeouts.

### Added

- **Proactive maintenance selector** (`proactiveMaintenance` improve process):
  due-gated, composite-priority (`importance × log(1+retrievalFreq) ×
  recencyDecay / log(size)`), bounded rotating top-N reflect/distill over
  stale/never-reflected assets. **Disabled by default**; enable per profile.
- **Eligibility attribution**: every reflect/distill proposal is stamped
  `eligibilitySource ∈ {signal-delta, high-retrieval, proactive, scope,
  unknown}` on `reflect_invoked`/`distill_invoked`/`promoted` events and the
  proposal record, so outcomes are sliceable by lane.
- **Measurement system** under `scripts/akm-eval/`: a real-query retrieval suite
  generated from `usage_events`, and `akm-eval-proactive-verdict` — a read-only
  kill-criterion runner comparing the proactive lane (treatment) vs due-but-
  untouched assets (control). Emits PASS/FAIL/INCONCLUSIVE and recommends
  disabling the lane on FAIL. New `proactive_selected` event +
  `proactiveSelected`/`proactiveDueTotal`/`proactiveNeverReflected` fields on
  `improve_completed`.

### Fixed

- Revived the P0-A high-retrieval fallback: genuinely zero-feedback assets were
  routed to the fully-skipped branch one phase before the fallback could see
  them, so frequently-retrieved-but-never-rated assets were never improved.
- `getRetrievalCounts` now normalizes bare vs `origin//`-prefixed refs (it was
  dropping ~half the retrieval signal) and counts `curate` events
  (`akm curate` now records per-item `entry_ref`).
- The fully-skipped `no_new_signal` branch emitted one `improve_skipped` event
  per ref (~11K writes/run, ~400K rows/day) — a contributor to 900s improve
  timeouts and state.db bloat. Collapsed into one aggregated counted event.

## [0.9.0-beta.8] - 2026-06-13

Fix multi-process SQLite contention in `index.db` and harden concurrent proposal
queue mutations.

### Changed

- Added a global `index.db` writer lease used by foreground indexing,
  background auto-index, improve maintenance index writers, graph updates, and
  feedback writes.
- Replaced the racy background index PID-file dedup flow with lease-based
  coordination and explicit handoff to the spawned worker.
- `akm feedback` now uses blocking index preparation and writes under the same
  `index.db` lease, avoiding self-inflicted `database is locked` failures.
- Proposal queue create/archive/gate-decision mutations now run under
  `BEGIN IMMEDIATE` state.db transactions so concurrent processes serialize on
  live queue state.

## [0.9.0-beta.7] - 2026-06-13

Fix the `akm improve` regression introduced by background `ensureIndex`.

### Changed

- Added an explicit `ensureIndex` mode so callers choose `background` or
  `blocking` behavior directly instead of relying on hidden environment state.
- `akm improve` now uses blocking index preparation before collecting eligible
  refs, restoring the post-upgrade empty-index recovery path.
- Removed the `AKM_INDEX_INLINE` test-only override so tests exercise the same
  index behavior model as production.

## [0.9.0-beta.6] - 2026-06-12

Pipeline optimization: new per-process config fields wire up the consolidation
and improve pipeline knobs exposed by the optimization report — incremental
consolidation, pool caps, distill gating, and memory inference throttling.

### Added

- **`consolidate.incrementalSince`** — profile config field that narrows the
  consolidation candidate pool to memories modified within the given window
  (e.g. `"1h"`, `"4h"`) plus their graph neighbours. Enables frequent
  consolidation passes (e.g. `quick-shredder` every 15 min) without full-pool
  sweeps. Absent = full-pool sweep (correct for nightly runs).
- **`consolidate.limit`** — hard cap on memories processed per consolidation
  pass, applied after incremental narrowing. Prevents runaway full-pool sweeps
  in the nightly default profile.
- **`consolidate.neighborsPerChanged`** — configurable graph-neighbour count
  per changed memory during incremental consolidation (was hardcoded to 5).
  `quick-shredder` sets this to 3 for a 40% candidate reduction per burst.
- **`distill.requirePlannedRefs`** — when `true`, the distill process is
  skipped entirely for distill-only refs when the reflect phase produced zero
  planned refs. Eliminates hundreds of `distill-skipped` events on quiet passes
  where all refs are on reflect cooldown.
- **`memoryInference.minPendingCount`** — minimum pending split-parent memory
  count below which the inference pass is skipped entirely (zero LLM calls).
  Prevents lock acquisition on passes where there is nothing to infer.
- **`reflect.limit`** — per-process ref limit for the reflect/distill loop,
  applied as the improve run limit when no CLI `--limit` is given.
- **New `reflect-distill` improve profile** — dedicated reflect + distill + 
  memoryInference + triage profile for the every-4h `akm-improve-frequent`
  task. `reflect.limit: 25` bounds LLM cost per pass.

### Changed

- **`quick-shredder` profile tuned**: `incrementalSince` `4h` → `1h`,
  `maxChunkSize` 25 → 35, added `minPoolSize: 10`, `neighborsPerChanged: 3`,
  `memoryInference.minPendingCount: 5`. All `profile: "qwen-9b-shredder"`
  process references removed — falls back to default LLM.
- **`default` improve profile** (nightly): extract disabled (dedicated
  `akm-extract` task runs at 01:48), consolidate gets `limit: 500`,
  reflect gets `limit: 100` and `allowedTypes`, distill gets
  `requirePlannedRefs: true`, triage enabled at 50 accepts/run,
  graphExtraction explicitly enabled.
- **Cron schedule optimised**: extract reverted to `8,28,48 * * * *` (3×/hr),
  quick-shredder shifted to `4,19,34,49` (4-min extract gap), health-report
  shifted to `:03` (avoids `:00` collision), `akm-improve-frequent` re-enabled
  at `45 */4` with `reflect-distill` profile.

## [0.9.0-beta.3] - 2026-06-12

Stabilization batch closing the remaining 0.9.0 milestone: DB-locking and
improve-pipeline perf backports, extract/reflect gate fixes, SQLite-first
proposal and log storage, `--format html` output, and per-stage LLM telemetry.

### Added

- **`--format html` output with per-command templates** (#582). `akm health
  --format html` renders the full interactive health report (ECharts inlined by
  default, or via CDN with `AKM_ECHARTS=cdn`); every other command falls back to
  a dark-mode default template that pretty-prints its JSON. A global `--output
  <path>` flag writes the rendered HTML to a file instead of stdout. Token
  replacement only — no template engine. The standalone health-report skill is
  now folded into core.
- **Per-stage LLM telemetry** (#576). Every `chatCompletion` call now records
  tokens (prompt/completion/total/reasoning), wall-time, model, and
  finish_reason as an `llm_usage` event, attributed to the pipeline stage via an
  ambient `AsyncLocalStorage` context (`withLlmStage`) set once per phase — no
  `stage` parameter threaded through call sites. `akm health` exposes per-stage
  token and time aggregates. Telemetry is best-effort and can never fail a run;
  capture is forward-only.
- **Per-proposal gate decision + confidence** (#577). When a proposal passes
  through the auto-accept/triage gate, its outcome (`auto-accepted` /
  `deferred` / `auto-rejected`), reason, confidence, measured value, and the
  thresholds in effect are persisted on the proposal (in the SQLite metadata).
  `akm proposal show`/`list` surface them with reconstructable comparisons
  (e.g. `0.72 < 0.90`), so tooling can explain *why* each proposal is pending
  instead of relying on a run-level aggregate. Forward-only; legacy proposals
  render `unknown`.

### Fixed

- **`SQLITE_BUSY` / "database is locked" under concurrent runs** (#584, #585,
  #589). `busy_timeout` raised from 5 s to 30 s on every SQLite open path
  (index.db and state.db); the improve maintenance pass now closes its index.db
  handle before each reindex (which opens its own writer to the same WAL file);
  and the post-loop purge reuses the long-lived events connection instead of
  opening a second state.db writer. Together these eliminate all observed
  lock failures from overlapping cron improve runs. (Backports of 0.8.8.)
- **Extract gate ignored the active profile's `extract.enabled: false`** (#593,
  #594). The session-extraction gate hardcoded the `default` profile, so a
  non-default profile (e.g. a quick pass) ran extract anyway — 300–600 s of
  redundant work per run when a dedicated extract task also exists. The gate
  now resolves `extract` against the active improve profile. (Backport of
  0.8.11.)
- **Memory inference burned LLM calls on already-derived parents** (#588). The
  primary pass now checks for the `<parent>.derived.md` child on disk *before*
  the LLM/cache call, and opportunistically marks the parent processed so it
  never re-pends. Previously ~55 % of the inference budget was spent
  rediscovering children that already existed.
- **Reflect no longer queues empty-diff or cosmetic-only proposals** (#580).
  A deterministic, LLM-free noise gate diffs each candidate against the current
  asset; byte-identical edits are dropped and changes that are pure formatting
  (whitespace reflow, hard-wrap changes, code-fence language hints, YAML scalar
  re-folding) are suppressed, each recorded via summary events so suppression
  rates are visible in `akm health`.

### Added

- **`minContentChars` pre-LLM extract gate** (#595, #596). Sessions whose raw
  size is below `profiles.improve.<name>.processes.extract.minContentChars`
  (default 10 — only truly empty sessions/journal files) skip the extract LLM
  call entirely. Gates on raw input size, not post-noise-filter size.
  (Backports of 0.8.12–0.8.14.)
- **Structured logs database** (#579). Task and run log lines now land in a
  dedicated `logs.db` (WAL, 30 s busy_timeout) keyed by task, run, stream, and
  time, with retention/purge wired into the existing purge pass and `ATTACH`
  support for joining log lines to `state.db` rows (e.g. a failed
  `task_history` row to its log output). The scattered-log audit and per-source
  keep/move/drop decisions are documented in `docs/technical/logs-audit.md`.

### Changed

- **Proposals are now stored canonically in SQLite** (#578). The previously
  bypassed `proposals` table in state.db is the single source of truth; all
  proposal commands (`list`/`show`/`diff`/`accept`/`reject`/`revert`/`drain`),
  the improve auto-accept gate, and health metrics read and write it through
  one storage layer. Pending file-based proposals are imported on first read;
  `akm proposal *` UX is unchanged. Design and migration notes live in
  `docs/technical/proposal-storage.md`.
- **Improve planning no longer does per-ref DB lookups or per-ref skip events**
  (#591, #592). Eligible refs carry a pre-resolved `filePath`, removing a
  serial async lookup per ref (~500 s on 9 k-ref stashes), and the
  profile-filtered skip loop emits one summary event with a count instead of
  thousands of rows. (Backports of 0.8.9–0.8.10.)

## [0.9.0-beta.2] - 2026-06-09

### Fixed

- **Consolidation starved merge recall; the memory pool grew unbounded.** Commit
  `633ece41` made the `incrementalSince` narrowing unconditional, so every
  consolidation run only judged memories changed since the last run plus their
  immediate vector-neighbors. Stale-but-unmerged duplicate clusters were never
  re-examined, so the eligible pool grew monotonically and never shrank, and
  contradiction detection (which rides on the consolidation pass) went dark.
  Consolidation only runs on the nightly default-profile pass (`quick`/`frequent`
  disable it), so a full-pool sweep is correct and affordable; the override is
  removed. `lastConsolidateTs` still gates whether the pass runs. (Forward-port
  of the 0.8.5 fix.)
- **`akm tasks sync` ignored schedule changes** — forward-ported from 0.8.4.
  Sync classified any task already present in the OS scheduler as "unchanged"
  without comparing its installed entry, so editing a task's `schedule:` in the
  `.yml` never reached the crontab; the same gap affected `tasks enable`/`disable`
  (toggled the comment, re-enabling a stale schedule). Sync now compares the
  backend's installed signature against the signature the current definition
  renders to and reinstalls on drift (new `updated[]` field); `enable`/`disable`
  reinstall from the current `.yml`. The cron backend gains `expectedSignature()`
  and a per-entry signature on `list()`; other backends fall back to an
  idempotent reinstall.

### Added

- **`akm improve --skip-if-locked`** — forward-ported from 0.8.4. When another
  improve run already holds the lock, the run logs and exits 0 with a no-op
  result (`skipped.reason: "lock-held"`) instead of failing with the "already
  running" config error (exit 78). Intended for high-frequency scheduled runs
  (e.g. an every-30-min `quick` pass) that overlap a longer run. Default off.

### Removed

- **`akm config edit`** — the interactive menu-based editor was removed. A
  prompt-driven drill-down was clunkier than just editing the file. Edit the
  config directly (the path is shown by `akm config path`), use
  `akm config set/get/unset` for scripted changes, and `akm config validate` to
  check it.

## [0.9.0-beta.1] - 2026-06-08

### Fixed

- **`improve.lock` leaked on signal death (cron timeout)** — forward-ported from
  0.8.3. The improve SIGTERM/SIGINT/SIGHUP handler calls `process.exit()`, which
  skips `finally` blocks, so the `finally` releasing `improve.lock` never ran and
  every timed-out cron run leaked the lock. It is now released from a
  `process.on("exit", …)` handler registered at acquire time, via a new
  ownership-checked `releaseLockIfOwned(path, pid)`.
- **`quick` profile was not quick** — forward-ported from 0.8.3. It did not
  disable the default-ON session-`extract` process, so a `quick` run processed
  the entire session backlog (~40 min). `quick` now sets
  `processes.extract.enabled: false`.
- **`akm-eval` smoke suite adapted to the 0.9.0 CLI** (CI/tooling only). The
  eval harness called `akm search --detail agent`, but 0.9.0 moved the
  agent/summary projections to `--shape`; it now uses `--shape agent`.
  Additionally, the improve-run history readers (`listRecentImproveRunIds` /
  `resolveImproveRunId`) treated a missing `state.db` as an error rather than
  "no runs", which broke the read-only smoke + replay-determinism gates on a
  fresh checkout; a missing `state.db` is now handled as an empty history.

## [0.9.0-beta.0] - 2026-06-08

### Added

- **Cross-runtime: akm now runs on Node.js (≥ 20) in addition to Bun** (#560,
  #465). A two-file runtime boundary (`src/storage/database.ts` owns SQLite via
  `bun:sqlite` on Bun / `better-sqlite3` on Node; `src/runtime.ts` owns every
  `Bun.*` API) contains all runtime-specific code, enforced by a lint guard so it
  cannot leak back out. A CI `node-smoke` matrix runs the built CLI under Node
  20 and 22. **Minimum Node is 20** — the prompts dependency (`@clack/core`) uses
  `node:util.styleText`, added in Node 20.12; Node 18 is EOL and unsupported.
  Bun remains the primary/default runtime.
- **`session` asset type — agent sessions are now searchable** (#561). The
  `extract` pass, after distilling memory proposals from a session, additionally
  writes the session itself as a first-class `session` asset
  (`sessions/<harness>/<id>.md`) with an LLM-generated `## Summary` /
  `## Key topics` body plus `harness` / `session_id` / `started_at` / `ended_at`
  / `project` / `log_path` / `access` frontmatter. Sessions become discoverable
  via `akm search --type session` and `akm curate`, and the `access` + `log_path`
  fields tell any agent how to open the raw session log. The behaviour is
  ADDITIVE, FAIL-OPEN, and config-gated via
  `profiles.improve.default.processes.extract.indexSessions` (default on when an
  LLM is configured; set `false` for byte-identical legacy extract behaviour) and
  `…extract.minSessionDuration` (default 5 minutes). Session assets are not
  graph-extracted. No new LLM call is made when no provider is configured.

- **`akm env set` / `akm env unset` — single-key `.env` management.** `akm env
  set <ref> <KEY>` sets/updates one key (value from stdin by default, or
  `--from-env <VAR>` / `--from-file <path>` — never argv, never echoed); `akm env
  unset <ref> <KEY...>` removes one or more keys. Both do a minimal edit that
  preserves existing comments and key order, and use `dotenv` as the
  serialisation oracle: a value is only written if `dotenv.parse` reads it back
  exactly, and the whole edit is re-verified so no sibling key is disturbed. This
  reintroduces key-level management (the deprecated `vault set`/`vault unset`
  pointed here); `akm env remove` still removes the whole file.

- **`--path` for subdirectory asset creation** (#503) — a consistent `--path
  <relative-dir>` flag across the asset-creating command surface: `akm remember`,
  `akm import`, `akm propose`, `akm workflow create`, `akm env create`, and
  `akm secret set`. `--path` is a directory applied rooted at the asset's type
  directory (e.g. `akm remember "buy milk" --path personal --name grocery-list`
  → `memories/personal/grocery-list.md`; `akm workflow create ship --path
  release` → `workflows/release/ship.md`). The filename/name still comes from the
  `--name`/name positional (or, for `remember`/`import`, the content/source slug).
  The explicit name is now a **flat** name everywhere: a `/` in it is rejected
  with guidance to use `--path`. System-derived names (e.g. a URL-path-derived
  knowledge name from `akm import <url>`) may still nest. Shared semantics live in
  `src/core/asset-create.ts`. (Replaces #503's earlier nested-`--name` approach.)
- **Workflow runs record agent harness + session identity** — `akm workflow start`
  now persists the agent harness (e.g. `claude-code`, `opencode`) and the
  platform-native session id that owns each run. Identity is resolved best-effort
  from the environment (`AKM_AGENT_HARNESS` / `AKM_SESSION_ID`, falling back to the
  harness-native session env var) or can be passed explicitly to `startWorkflowRun`.
  Stored via additive migration `002-add-agent-identity` and surfaced on
  `WorkflowRunSummary.agentHarness` / `.agentSessionId`. This is the first concrete,
  scoped slice toward workflow session monitoring (#501).
- **Workflow agent check-in + step-summary validation** (#506) — workflow runs now
  use a file-signal / command-loop check-in model (no resident background thread, per
  the ADR in `docs/technical/workflow-agent-checkin-adr.md`). `akm workflow start`
  arms a durable check-in timestamp; `akm workflow complete --summary` now **requires**
  a per-step summary and runs it through an LLM completion-criteria validation gate —
  on failure the step stays pending and structured corrective feedback is returned
  (`workflow-complete-rejected`). A pure `evaluateCheckin` surfaces a strong `continue`
  directive through `getNextWorkflowStep` when an active run looks stalled. Migration
  `002` adds `agent_harness`, `agent_session_id`, `checkin_armed_at` on
  `workflow_runs` and `summary` on `workflow_run_steps`.
- **Default improve profiles + scheduled task set** (#552) — three new bundled
  profiles in `src/assets/profiles/` — `frequent` (extract + inference; distill /
  consolidate excluded), `consolidate` (consolidation-only), and `catchup` (manual
  recovery: consolidate + triage drain) — alongside the existing `default` / `quick` /
  `thorough` / `memory-focus` / `graph-refresh`. `akm setup` and the new `akm tasks
  init` register a multi-cadence task set **idempotently**: `akm-improve-frequent`
  (60 min), `akm-improve-consolidate` (4 h), `akm-improve-nightly` (`thorough`, daily
  2 am, server-gated), `akm-improve-catchup` (registered but unscheduled), and
  `akm-graph-refresh-weekly` (Sun 3 am). Registration is CI-aware (skips when
  `CI=true`) and asks a single "Is this a server install?" prompt to gate the nightly
  task (default yes on Linux-without-battery, no on macOS/laptop).

### Design notes

- **#501 narrowed; superseded by #506 for the monitoring design.** Issue #501
  ("Add background thread for workflow command session monitoring and agent
  prompting") was an epic. Per #506's stated preference to avoid always-on
  background threads/daemons, the background-thread requirement is **not**
  implemented here. #501 is narrowed to the one tractable, prerequisite sub-feature
  — persisting harness + session identity on each workflow run — which any future
  monitor needs regardless of design. The session-monitoring/agent-steering loop is
  deferred to #506 and requires a separately approved design.

### Changed

- **`improve`: consolidation runs before extract + smarter pool-delta gate**
  (#551). The consolidation phase now runs **before** the session-extract pass
  in the improve pipeline. Extract auto-accept writes new memory `.md` files on
  every run, which previously made the consolidation pool-delta gate
  (`memoryUpdatedAfterLastConsolidate`) fire unconditionally — consolidation
  never skipped and wastefully re-judged freshly-promoted single-source
  memories with no merge/contradiction candidates yet. Running consolidation
  first means it only ever sees memories from **prior** runs; current-run
  extract promotions are not on disk yet. The pool-delta gate is additionally
  narrowed: a memory whose only mtime bump since the last consolidate came from
  its **own** auto-accept promotion (tracked via the `promoted` event's
  `assetPath`) is excluded from the "work to do" check, so adjacent-run
  promotions get a full improve cycle to settle before consolidation considers
  them. When the gate now correctly skips, the existing
  `improve_skipped` / `consolidation_no_memory_updates` event is emitted so
  health reflects it. No event-shape changes; emitted-event order changes only
  because consolidation moved earlier.

- **Unified git commit model — single batch-at-boundary commit** (#507). Writing
  or deleting an asset on a git-backed source no longer commits (and optionally
  pushes) **per asset**. `writeAssetToSource` / `deleteAssetFromSource` now
  perform a plain filesystem write/unlink for every kind, and git-backed targets
  are committed **once** at the operation boundary (`akm remember --target`,
  proposal accept/revert, consolidate) as a single complete commit — `git add -A`
  stages `.akm/` state + sibling assets together — pushed under the same
  `writable + remote` gate as `akm save`/`akm sync`. This removes the noisy,
  incomplete per-asset commits (~25 per improve run) and leaves no dirty
  working-tree residue.

- **`improve/consolidate`: `minPoolSize` guard** (#553). Consolidation now skips
  itself when the eligible memory pool is below `processes.consolidate.minPoolSize`
  (default **500**), emitting a `consolidation_skipped` event with
  `reason: pool_below_min_size` and making **zero** LLM calls — so the always-enabled
  consolidate task self-activates only once a stash is large enough to have real
  merge/contradiction candidates. `minPoolSize: 0` disables the guard. The skip
  surfaces in `akm health` improve output. The bundled `consolidate` profile sets
  `500`, `catchup` sets `0`.

- **`improve/extract`: `minNewSessions` gate** (#554). The extract phase now counts
  in-window, not-yet-seen candidate sessions **before** any LLM call and skips the
  pass (emitting `extract_skipped` / `reason: below_min_new_sessions`, visible in
  `akm health`) when the count is below `processes.extract.minNewSessions`. The
  in-code default is **0 (disabled)**, so existing profiles keep always-run behaviour;
  only the new `frequent` profile opts in with `3`. This removes the ~22% of improve
  runs that previously ran the full `ensureIndex` + extract pipeline for zero new
  sessions.

### Deprecated

- **`options.pushOnCommit`** (#507). The per-asset push-on-commit knob is retired.
  Existing configs still parse — its push intent is mapped onto the batch push
  gate and a one-time deprecation warning is emitted when the option is
  encountered. Remove it and rely on `writable: true` + a configured remote.

### Fixed

- **Memory inference re-queued `hot` parents forever** (#550). `markParentProcessed`
  was only called when a derived child was newly written; when the child already
  existed (`written = 0`), the parent never got `inferenceProcessed: true` and was
  re-queued on every `akm improve` run (~37 wasted LLM calls/run on one production
  stash). The child-exists path now marks the parent done (a genuine write failure
  still leaves it unmarked for retry), while `skippedChildExists` accounting is
  unchanged.
- **Auto-accept rejected truncated LLM descriptions** (#556). ~9.3% of proposals
  failed auto-accept validation because the LLM cut the description mid-clause (ending
  in `to`/`for`/`and`/a comma/etc.) or lost a YAML continuation line. A deterministic
  post-generation repair pass (`repairTruncatedDescription` in
  `src/core/text-truncation.ts`) now trims the truncated fragment to the last complete
  clause or swaps in the first complete sentence from the body — never fabricating
  text — wired into the extract and distill proposal-write paths before validation.
  Already-valid descriptions pass through byte-identical. (Plus a one-line prompt
  tightening requiring a complete sentence.)
- **Semantic index verification stuck on stashes with vault entries** (#502).
  Verification compared the stored embedding count against the *full* entry count, but
  the embedding phase intentionally excludes vault rows — so any index with vault
  entries reported `embeddingCount < totalEntries` forever and stayed in
  semantic-blocked / verification-failed state. A new `getEmbeddableEntryCount`
  (`entry_type != 'vault'`) now feeds the zero-entry short-circuit, the readiness gate,
  the "Semantic search ready (X/Y)" message, and the persisted `entryCount`; a
  genuinely missing embedding on an embeddable entry still reports `ok:false`.

### Internal

- **#490 architecture refactor.** Decomposed `src/cli.ts` from **4,589 → 620 LOC**
  across 16 per-family command modules under `src/commands/*-cli.ts` (adopting a
  `defineJsonCommand` factory for byte-identical JSON envelopes); converted `akm
  health` checks to an ordered `HealthCheck` registry; and turned the
  `migrate-storage` bin's 54 hand-rolled `recordStep` sites into a `MigrationStep`
  registry with 3 recursive copy helpers unified into one `copyTree`. Shipped as
  serialized local merges with a zero-behaviour-change contract (byte-identical CLI
  surface + JSON envelopes), each gated and reviewed; the secret-migrating
  `migrate-storage` change is pinned by a sha256 + file-mode fixture-stash
  differential test.

## [0.8.14] - 2026-06-11

### Fixed

- **`akm extract` minContentChars default lowered from 500 to 10.** The 500-char
  threshold used inputCount (raw session size) but analysis showed 209 of 218
  candidate-producing sessions had inputCount < 500 — tiny agent sessions (22–368
  chars) regularly yield 1–5 candidates. The only reliably skippable sessions are
  empty ones (0 chars, journal files). Default lowered to 10 to catch only
  truly empty sessions while preserving all signal-bearing content. Closes #597.

## [0.8.13] - 2026-06-11

### Fixed

- **`akm extract` minContentChars gate filtered all sessions.** The threshold was
  checked against `filtered.stats.outputCount` (post-noise-filter chars), but the
  pre-filter strips so much boilerplate that even signal-bearing sessions end up
  below 500 chars of output. All 75 sessions in the first post-deploy run were
  filtered, dropping candidates from 4–13 to 0. Fix: gate on `inputCount` (raw
  session size) instead — a session with < 500 raw chars has nothing worth
  extracting regardless of what the pre-filter produces. Closes #596.

## [0.8.12] - 2026-06-11

### Fixed

- **`akm extract` calling the LLM for noise sessions that never yield candidates.**
  96% of processed sessions (72/75 measured) produced zero candidates, consuming
  ~330 s of LLM time per run. The pre-filter had no minimum content threshold —
  sessions as short as 50 chars were sent to the LLM regardless. A new
  `minContentChars` gate (default 500) skips the LLM call when post-filter
  content falls below threshold, cutting extract LLM calls by ~95% on typical
  stashes. Configurable via `profiles.improve.<name>.processes.extract.minContentChars`.
  Closes #595.

## [0.8.11] - 2026-06-11

### Fixed

- **`akm improve --profile <name>` ignored profile's `extract.enabled: false` setting.**
  The session-extraction gate in the preparation stage called
  `isLlmFeatureEnabled(config, "session_extraction")`, which hardcodes a lookup
  against `profiles.improve.default.processes.extract.enabled`. Any non-default
  profile that set `extract.enabled: false` (e.g. `quick-shredder`) was silently
  ignored, causing the extract pass to run regardless. The fix adds a
  `resolveProcessEnabled("extract", improveProfile)` check so the active
  resolved profile gates the pass correctly. Closes #593.

## [0.8.10] - 2026-06-11

### Fixed

- **`akm improve` taking 8–10 minutes per run due to O(n) DB writes for
  profile-filtered refs.** When a profile disables reflect and distill for
  certain asset types, `collectEligibleRefs` marks those refs as
  `profile_filtered_all_passes`. The caller then emitted one `improve_skipped`
  event per ref — a sequential DB write for each. On a ~9 000-ref stash this
  was ~500 s of SQLite writes before any consolidation or memory inference
  began. The fix collapses the per-ref loop into a single summary event
  carrying a `count` field, eliminating ~9 000 sequential writes per run.
  Closes #590.

## [0.8.9] - 2026-06-11

### Fixed

- **`akm improve` validation pass was O(n) in stash size, causing ~510 s overhead
  on large stashes.** For every indexed ref, the preparation phase called
  `findAssetFilePath()` — an async round-trip to the index DB followed by a
  filesystem probe — serially inside a `for…await` loop. With ~9 000 indexed
  refs at ~55 ms each, this loop consumed the entire 600–900 s run budget before
  any reflect, triage, or memory-inference work began. The fix threads
  `filePath` from the planning stage (`collectEligibleRefs`) through
  `ImproveEligibleRef` so the validation pass and the disk-existence guard can
  use the pre-resolved path directly. The async lookup is retained only as a
  fallback for refs that enter via a narrow scope (e.g. `--scope ref:foo`).
  Closes #587.

## [0.8.8] - 2026-06-11

### Fixed

- **SQLite `SQLITE_BUSY` errors under concurrent improve runs.** `busy_timeout`
  was set to 5 000 ms in all three database open paths (`openDatabase`,
  `openExistingDatabase`, `openStateDatabase`). Under a busy cron schedule — or
  when a reindex triggered by memory inference ran concurrently with an event
  write — the 5 s window was routinely exhausted, producing "database is locked"
  failures. Raised to 30 000 ms across all three paths so transient lock
  contention is retried for up to 30 s before surfacing as an error.

## [0.8.7] - 2026-06-09

### Fixed

- **`incrementalSince` duration strings were silently ignored.** Values like
  `"30m"`, `"24h"`, `"7d"` were passed raw to `narrowToIncrementalCandidates`,
  which compared them against ISO timestamps via string sort. All `2026-...`
  timestamps are lexicographically less than `"30m"` (`'2' < '3'`) and `"24h"`
  (`"20" < "24"`), so `isChanged()` always returned `false` and the candidate
  pool was silently emptied rather than filtered to the window. The fix adds
  `parseSinceToIso()`, which resolves human duration strings to absolute ISO
  timestamps before comparison. Values that already look like ISO timestamps
  are passed through unchanged.

## [0.8.6] - 2026-06-09

### Added

- **`consolidate.incrementalSince` profile config field.** Setting
  `incrementalSince: "7d"` (or any duration string) in the `consolidate` block
  of an improve profile narrows the candidate pool to memories modified within
  that window plus their top-5 graph neighbours, keeping each pass focused on
  recent changes. This makes it practical to run consolidation more often than
  once per day (e.g. via `akm-improve-consolidate` every 4 h) without
  re-scanning the full pool every time. The nightly default profile leaves this
  unset (full-pool sweep, same as before). The `incrementalSince` option already
  existed in `akmConsolidate()` but was hardcoded off at the call site; the
  field is now surfaced in the config schema and read from the profile.

## [0.8.5] - 2026-06-09

### Fixed

- **Consolidation starved merge recall; the memory pool grew unbounded.** Commit
  `633ece41` made the `incrementalSince` narrowing unconditional, so every
  consolidation run only judged memories changed since the last run plus their
  immediate vector-neighbors. Stale-but-unmerged duplicate clusters were never
  re-examined, so the eligible pool grew monotonically and never shrank, and
  contradiction detection (which rides on the consolidation pass) went dark.
  Consolidation only runs on the nightly default-profile pass (`quick`/`frequent`
  disable it), so a full-pool sweep is correct and affordable; the override is
  removed. `lastConsolidateTs` still gates whether the pass runs.

## [0.8.4] - 2026-06-08

### Fixed

- **`akm tasks sync` ignored schedule changes.** Sync classified any task already
  present in the OS scheduler as "unchanged" without comparing its installed
  entry, so editing a task's `schedule:` in the `.yml` never reached the crontab —
  the only way to apply a new schedule was to `remove` and re-`add` the task. The
  same gap affected `tasks enable`/`disable`, which merely toggled the existing
  cron line's comment and so re-enabled a stale schedule. Sync now compares the
  backend's installed signature against the signature the current definition would
  produce and reinstalls on drift (reported in a new `updated[]` field);
  `enable`/`disable` reinstall from the current `.yml` instead of toggling in
  place. Backends that can't cheaply read their installed form fall back to an
  idempotent reinstall, so the fix is correct on launchd/schtasks too. The cron
  backend gains `expectedSignature()` and a signature on each `list()` entry.

### Added

- **`akm improve --skip-if-locked`.** When another improve run already holds the
  lock, the run logs and exits 0 with a no-op result (`skipped.reason:
  "lock-held"`) instead of failing with the "already running" config error
  (exit 78). Intended for high-frequency scheduled runs (e.g. an every-30-min
  `quick` pass) that would otherwise pile up exit-78 failures whenever a longer
  run overlaps them. Default off — the hard error is preserved for interactive
  use. The result is still recorded so the skip is auditable.

## [0.8.3] - 2026-06-08

### Fixed

- **`improve.lock` leaked on signal death (cron timeout).** The improve
  SIGTERM/SIGINT/SIGHUP handler calls `process.exit()`, which skips `finally`
  blocks — so the `finally` that releases `improve.lock` never ran, and every
  timed-out cron run leaked the lock sentinel. (It wasn't a permanent deadlock
  only because the next run reclaims a dead-PID lock, a path that PID reuse can
  defeat.) The lock is now released from a `process.on("exit", …)` handler
  registered at acquire time (exit handlers DO run on `process.exit()`), via a
  new ownership-checked `releaseLockIfOwned(path, pid)` so a backstop release can
  never delete a different run's lock. This generalizes to the budget watchdog
  and any future exit path.
- **`quick` profile was not quick.** It was documented "Reflect-only" but did
  not disable the session-`extract` process (which is default-ON), so a `quick`
  run processed the entire unindexed-session backlog (~40 min) — guaranteeing a
  5-minute cron timeout → SIGTERM → the lock leak above, every run. `quick` now
  explicitly sets `processes.extract.enabled: false`.

## [0.8.2] - 2026-06-05

### Added

- **LM Studio auto-detection in setup wizard** — `akm setup` now probes
  `localhost:1234/v1/models` at startup and, when the server is running, pre-fills
  the LLM backend with the active model list, mirroring the existing Ollama detection
  flow (#522).
- **Agent harness config import** — `akm setup` detects installed AI coding harnesses
  (currently Claude Code and OpenCode) and pre-populates LLM provider, model, and
  base-URL fields from the harness configuration. The importer registry
  (`HARNESS_CONFIG_IMPORTERS`) makes adding future harnesses a single append (#523).
  API key *values* are never read or stored — only the environment variable name is
  imported.
- **Registry-driven stash selection** — the "Add Sources" step now fetches available
  stashes from the official AKM registry at startup. `DEFAULT_SELECTED_STASH_IDS`
  in `src/setup/registry-stash-loader.ts` is the single edit point for changing
  which stashes are pre-checked. Falls back to a hardcoded list on network error (#520).
- **`improve.autoAccept.{promoted,validationFailed}` health metrics** — auto-accepted
  proposals that pass the confidence threshold but fail validation (truncated
  description, invalid frontmatter) are now counted as `gateAutoAcceptFailedCount`
  in the improve result envelope and surfaced as `improve.autoAccept.validationFailed`
  in `akm health` reports.
- **`auto-accept-validation` health advisory** — heuristic advisory that warns when
  `validationFailed > 0` so malformed proposals are visible before they pile up in
  the queue.

### Fixed

- **`akm-improve` tasks recorded as failed on budget exhaustion** — the budget
  exhaustion timer called `process.exit(1)`, causing every budget-limited run to be
  recorded as a task failure. Changed to `process.exit(0)`; budget exhaustion is a
  normal exit condition.
- **`improve_runs.started_at` always equal to `completed_at`** — `writeImproveResultFile`
  was called at end-of-run, so `new Date()` captured the completion time and both
  columns held the same value (649/661 real runs affected, regressed ~May 26).
  `started_at` now uses the timestamp captured at process launch, passed in from the
  CLI entry point. A regex-based fallback decodes the timestamp embedded in the run ID
  for any call site that does not supply an explicit value (#524).
- **`akm-health-report` task fails on transient DNS errors** — the Discord webhook
  script caught `HTTPError` but not the parent `URLError`, so DNS blips caused the
  task runner to record the health report as failed. `URLError` is now caught and
  logged as a warning with a clean exit.

### Added

- **Stash `.meta/` convention** — a stash may carry an optional, human-authored
  `.meta/` directory at its root for orientation: purpose, key assets, conventions,
  and maintainer info. Surface it on demand with `akm show meta` (the working
  stash's `.meta/index.md`), `akm show meta:<name>` (e.g. `.meta/about.md`), or
  scope it to a specific stash with `akm show <origin>//meta[:<name>]`. Because
  `.meta/` is a dot-directory, the indexer already skips it, so these docs never
  pollute search results — they are direct-read on demand. Owners extend the
  convention by dropping new files (`.meta/about.md`, `.meta/conventions.md`,
  `.meta/license`) with no code changes. `akm init` scaffolds a `.meta/index.md`
  template into newly created stashes.
- **Default stash skeleton** — `akm init` (and `akm setup`) now copies
  `src/assets/stash-skeleton/` into every newly created stash. Currently ships
  a `README.md` covering what the stash contains and how agents use `akm` to
  access assets. Existing files are never overwritten. Add files to
  `src/assets/stash-skeleton/` to extend what ships with a fresh install.

### Improved

- **Setup wizard pre-populates from existing config** — on re-run, `akm setup`
  initialises every prompt default from the current saved configuration so users
  only need to change what has actually changed (#519).
- **Config backup before every setup write** — `backupExistingConfig()` is now called
  before each `saveConfig` in the setup wizard, ensuring the previous config is always
  recoverable if a wizard run is interrupted (#521).

## [0.8.1] - 2026-06-05

### Added

- **`graph-refresh` improve profile** — new built-in profile that runs a full-corpus
  graph extraction pass across all stash files (all other improve processes disabled).
  Use `akm improve --profile graph-refresh` for a weekly relationship rebuild.
  Pairs with the new `graph-refresh-weekly` task template (`akm tasks add --template graph-refresh-weekly`).
- **`session-extraction` health advisory** — new heuristic advisory backed by real
  `akmExtract` outcomes: warns when the session-extraction process ran but produced
  zero proposals across ≥ 5 sessions, or recorded warnings. Replaces the vestigial
  `session-log-failures` warn signal.
- **`improve.sessionExtraction` health metrics** — `sessionsScanned`, `sessionsExtracted`,
  `sessionsSkipped`, `proposalsCreated`, `warnings`, `durationMs` now tracked and
  visible in `akm health` reports.

### Fixed

- **`akm info` indexStats** — `readIndexStats` errors are now surfaced and the resolved
  DB path is passed correctly; `entryCount`, `hasEmbeddings`, and related fields are
  no longer silently empty (#510).
- **Indexer timing fields** — `embedMs` and `ftsMs` in timing output had their
  operands swapped, producing negative durations. Fixed (#516).
- **Incremental consolidation gate** — the `volumeTriggered` path bypassed the
  incremental gate introduced in 0.8.0, causing consolidation to run on chunks it
  had already processed in the same run. Fixed.
- **Improve budget exhaustion** — `improve.lock` was not released after budget
  exhaustion, blocking subsequent runs until the lock TTL expired.
- **Consolidation chunk retry** — failed chunks are now retried once with a 2 s
  backoff before being recorded as lost, reducing transient LLM errors from
  propagating to `chunksFailed`.
- **`yieldRate` health metric** — `skippedAborted` refs were incorrectly counted in
  `freshAttempts`, inflating the denominator and underreporting yield rate.
- **`session-log-failures` advisory** — demoted from `warn` to always `pass`
  (informational only); the advisory was a raw regex counter with no LLM signal,
  producing false positives on normal session content.

### Refactored

- All runtime assets consolidated under `src/assets/` with `dist/assets/` mirroring
  the layout exactly. Built-in improve profiles moved from in-source object literals
  to embedded JSON files (`src/assets/profiles/*.json`). The `copy-assets.ts` build
  step now uses a precise `src/assets/**/*` glob instead of a broad catch-all.
- Vestigial Phase 0 (`getExecutionLogCandidates` / `ERROR_PATTERNS`) removed from
  the improve pipeline. This regex scan collected a metric count but never fed an
  LLM; `akmExtract` (Phase 0.4) is the real session extraction pipeline.

## [0.8.0] - 2026-05-28

### Performance

- **`akm consolidate`**: all-hot chunk early-exit. When every memory in a chunk
  is `captureMode: hot` (user-explicit), the only operations the LLM could ever
  propose are deletes — all refused unconditionally by the downstream guard.
  Such chunks now skip the model entirely and are counted as `judgedNoAction`
  up front, instead of relying on a prompt-level hint and spending a wasted
  request. Mixed chunks are unaffected.

### Breaking changes (deprecation aliases, removed 0.9.0)

The 0.8 line is the clean-break window for CLI ergonomics. Every rename below
keeps the **old spelling working** as a deprecated alias that prints a stderr
warning (never on stdout, so JSON consumers are unaffected) and delegates to the
canonical form. **All of these deprecated aliases are removed in 0.9.0.** See
[`docs/migration/v0.8-to-v0.9.md`](docs/migration/v0.8-to-v0.9.md) for the full
old → new table.

- **Proposal queue is now a noun group**: `akm proposal {list,show,diff,accept,reject,revert}`.
  The flat verbs `akm proposals`, `akm show proposal <id>`, `akm accept`,
  `akm reject`, `akm diff`, and `akm revert` are deprecated aliases.
  Bare `akm proposal` behaves as `akm proposal list`.
- **`--detail` is now verbosity only** (`brief|normal|full`). The output
  *projection* moved to a new **`--shape`** flag (`human|agent|summary`).
  `--detail summary` and `--detail agent` are deprecated aliases that map to
  `--shape summary` / `--shape agent`.
- **`--for-agent`** is a deprecated alias for `--shape agent`.
- **`--generator`** replaces `--source` on `accept` / `reject` / `history`
  (which generator produced the proposal/event). `--source` is a deprecated
  alias on **those three commands only** — it is unchanged on
  `search` / `curate` / `graph` / `remember`, where it means "read from here".
- **`akm save` → `akm sync`** (commit + optional push; `sync` connotes push
  better). `akm save` is a deprecated alias. `akm sync` adds `--no-push`.
- **`akm enable` / `akm disable` → `akm config enable` / `akm config disable`**.
  The top-level `enable` / `disable` are deprecated aliases.
- **`akm events` → `akm log`**: `log` is an additive alias for the same
  state.db stream in 0.8 and becomes primary in 0.9.0. (`akm history` remains the
  asset-scoped, cross-source analytical trail — a different surface.)
- **`akm wiki remove --force` → `-y` / `--yes`** for skipping the confirmation
  prompt. `wiki remove` now also *prompts* interactively when a TTY is present;
  `--force` is a deprecated alias for `-y`.
- **`akm feedback --note` → `--reason`**: `--note` is a deprecated alias and
  warns when used without `--reason`.
- **`akm workflow next --dry-run` removed**: the flag is no longer declared, so
  it no longer appears in `--help`. The explicit "next does not support
  --dry-run" guard remains (read from argv) so existing callers still get a clear
  message instead of silent acceptance.
- **Singular aliases added** (additive, non-breaking): `akm task` for
  `akm tasks`, `akm lesson` for `akm lessons`.

### Safety

Two destructive paths that previously acted with no confirmation now guard
behind an interactive prompt (or `-y` / `--yes` in non-interactive use).
**Scripts that ran these non-interactively must add `-y`.**

- **`akm registry remove`** now confirms before splicing the registry out of the
  config (`confirmDestructive`). Pass `-y` / `--yes` to skip the prompt;
  non-interactive use without `-y` aborts.
- **Bulk `akm proposal accept --generator <g>`** (the multi-proposal branch) now
  confirms before promoting every matching proposal, mirroring the existing
  guard on bulk `reject`. Single-id accept stays unguarded (it is revertable).

### Fixed

- **Consolidation `delete_failed` on stale index entries** — when consolidation
  successfully deleted a memory file, the index DB was not re-indexed between
  runs. Subsequent runs loaded the stale DB entry into their memory map, the LLM
  re-proposed the deletion, and `deleteAssetFromSource` threw "not found in
  source" — appearing as `delete_failed` in skipReasons. Fix: `loadMemoriesForSource`
  now filters entries whose file no longer exists on disk before building chunks,
  so phantom memories are never sent to the LLM. A secondary catch in the delete
  handler emits `delete_already_gone` instead of `delete_failed` when the file
  is confirmed absent.

> **CI / Docker users:** the 0.8.0 storage split moved `akm.lock`, the event
> database, and the registry cache out of `$XDG_CONFIG_HOME/akm/` into
> `$XDG_DATA_HOME`, `$XDG_STATE_HOME`, and `$XDG_CACHE_HOME` respectively. If
> you override any of `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`,
> `AKM_CACHE_DIR` in CI to isolate per-job state, set **all four** (or none,
> and rely on XDG defaults). Overriding only `AKM_CONFIG_DIR` will leave the
> lock file / event DB pointing at the host's default `$XDG_DATA_HOME`,
> causing lock contention and bleed between jobs.

### Removed

- **Install-time security audit (`security.installAudit`) and the `--trust`
  flag**. The audit scanned incoming stash assets for risky patterns (e.g.
  `curl ... | bash`, "ignore previous instructions") and blocked installs on
  critical findings. In practice it produced too many false positives on
  benign documentation strings and forced first-time users to pass `--trust`
  or twiddle config just to install the official stash. The whole feature is
  gone:
  - `akm add` and `akm update` no longer scan synced content.
  - The `--trust` flag is removed from `akm add` and `akm wiki register`.
  - The `security.installAudit.*` config keys (`enabled`, `blockOnCritical`,
    `registryAllowlist`, `registryWhitelist`, `blockUnlistedRegistries`,
    `allowedFindings`) are no longer recognised; the entire `security` block
    is removed from the config schema.
  - The `akm config set security.installAudit.*` keys now error as unknown.
  - `audit` fields are removed from `AddResponse.installed` and
    `SourceInstallStatus`.

### Breaking Changes

- **Project-level `.akm/config.json` files are no longer merged**. The
  multi-layer config discovery introduced in the 0.7 line was deprecated
  in late-0.8.x with a warning; that warning is now backed by removal.
  `loadConfig` walks cwd-ancestors only to emit a one-time deprecation
  warning per discovered file. Move any needed settings to
  `~/.config/akm/config.json`. `stashInheritance` (a multi-layer-only
  field) is removed from the schema.

- **`${VAR}` env-var expansion only resolves at the apiKey consumption
  sites**. The recursive expansion walker that ran on the load path is
  gone. Other config string values now round-trip verbatim: a literal
  `${HOME}` in (say) `stashDir` is preserved as the literal `${HOME}`
  on read. The new exported `resolveSecret(value)` helper is applied
  only where authorization headers are built (`src/llm/client.ts`,
  `src/llm/embedders/remote.ts`, `src/integrations/agent/sdk-runner.ts`).
  Documented `${OPENAI_API_KEY}` recipes in `docs/configuration.md`
  continue to work because expansion still happens at request time for
  apiKey fields.

- **`AKM_FORCE_DOWNGRADE_CONFIG` env var removed**. The newer-than-binary
  read-only guard (`configReadOnlyReason`, `markConfigReadOnlyIfNewer`,
  `getConfigReadOnlyReason`) is gone. Configs declaring a `configVersion`
  newer than the running binary now save through silently — unknown
  fields are stripped on save by `sanitizeConfigForWrite` plus the
  strict-walled Zod schema. Users on 0.9.x configs should not open them
  with a 0.8.x binary in writable workflows.

### Changed

- **Rebrand**: the full name "Agent Kit Manager" is now **Agent Knowledge Management** — `akm` stands for Agent Knowledge Management going forward. The binary name, npm package (`akm-cli`), and all APIs remain unchanged.

- **Config layer rewrite** — single-source-of-truth Zod schema in
  `src/core/config-schema.ts` replaces the per-field parse switch AND
  the per-shape load-time parser. Adding a new config field is now one
  line of schema + zero lines of CLI code. `loadConfig` now consists of
  parse-text → migrate (pure JSON transforms) → Zod safeParse → overlay
  defaults — a ~30-line pipeline that absorbs ~900 LOC of legacy
  per-shape parsers (`parseLlmConfig`, `parseEmbeddingConfig`,
  `parseIndexConfig`, `parseSourceConfigEntry`, and ~20 more).
  - **#454**: `akm config set llm.apiKey` / `embedding.apiKey` /
    `profiles.llm.<name>.apiKey` now throws `UsageError` pointing at the
    corresponding env var (`AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`,
    `AKM_PROFILE_<NAME>_API_KEY`). Was previously a silent strip.
  - **#455**: every schema-leaf key is now reachable via `akm config set`.
    Includes previously hand-listed gaps: `defaults.agent`, `search.minScore`,
    `improve.eventRetentionDays`, `embedding.provider`, `llm.temperature`,
    `profiles.llm.<name>.*`, `profiles.agent.<name>.*`, etc.
  - **#456**: `akm config validate` and `akm config migrate` are now real
    registered subcommands. The orphan implementations in `config-validate.ts`
    have been removed; the new entry points live in `src/cli/`.
  - **#457**: project-level `.akm/config.json` files are now flagged with a
    deprecation warning ("will be ignored in 0.9.0+"). The merge still
    happens in 0.8.x — one release of grace.
  - **#458**: malformed JSON or non-object root in the config file now raises
    `ConfigError("INVALID_CONFIG_FILE")` with the underlying parse error.
    Was previously a silent fallback to `DEFAULT_CONFIG`, which masked
    corruption. File-not-existing remains the legitimate cold-start case.
  - **#459**: `~/.cache/akm/config-backups/` is now bounded to the 5 most
    recent timestamped backups. Pruning runs on each `saveConfig`.
    `config.latest.json` is preserved separately.
  - **#460**: `UNKNOWN_CONFIG_KEY_HINT` is now auto-generated from the
    schema via `listTopLevelConfigKeys()`. No more stale hand-maintained string.
  - **#461**: if the auto-migration disk-write fails, `loadConfig` now throws
    a hard error instead of returning the in-memory migrated shape. Eliminates
    the silent infinite re-migrate loop on every `akm` command.
  - **#462**: nested registries[], sources[], profiles.* objects are
    `.strict()` — unknown keys are rejected with a path-pointing error at
    both set time and saveConfig time.
  - **#463**: `schemas/akm-config.json` is now auto-generated from the Zod
    source via `bun scripts/gen-config-schema.ts`. A drift test fails CI if
    the committed file disagrees with the regeneration output.
  - **#464.a**: `defaultWriteTarget` is validated via Zod `.refine()` against
    `sources[].name`. With no sources configured, save-time validation
    rejects instead of silently accepting (no implicit "first writable" fallback).
  - **#464.b**: generic unset works on `semanticSearchMode` and every other
    key via the dotted-path walker.
  - **#464.c**: all write paths route through `writeFileAtomic`.
  - **#464.d**: duplicate `mergeSecurityConfig` / `mergeInstallAuditConfig`
    in `config-cli.ts` are deleted; merging happens via re-parse through the
    Zod schema.

See `docs/migration/v0.7-to-v0.8.md` for the user-facing migration guide.

## [0.7.5] - 2026-05-08

### Added

- **Feedback tag/filter filtering** — `akm feedback` and related event-reading paths now support richer filtering by tags and other event metadata, making it easier to inspect and reuse accumulated feedback signals.
- **Vault path/run UX improvements** — vault flows now better support path discovery and command-scoped secret injection without surfacing values, with expanded regression coverage for the path/run contract.
- **Reflect fallback improvements for external agents** — reflection/proposal flows now support a more robust fallback path for proposal content, including the file-write path used by the `opencode` agent integration.

### Changed

- **Workflow runs are now scoped to the current workspace** — ref-based workflow commands (`workflow next/status/list`) now resolve runs within the current project, worktree, or non-repo directory instead of sharing active-run state globally across the whole cache. Direct run-id commands still target the exact run.
- **Help, hints, and workflow docs now explain run scoping** — CLI descriptions, embedded hints, operator docs, and workflow guides now describe the current-scope semantics so users understand how ref-based run resolution behaves across repos and local sandboxes.
- **`akm show` auto-indexes stale state instead of falling back to raw filesystem reads** — show/search parity is tighter because stale index state now triggers refresh rather than silently drifting to a separate fallback path.
- **Release metadata lookup follows the published `CHANGELOG.md` layout** — migration-help, package publish metadata, and related docs now consistently reference the shipped changelog location at the package root.
- **Documentation refresh across README and posts** — README positioning, command-tour docs, workflow examples, and dev.to post organization were refreshed to better match the current CLI surface.

### Fixed

- **Cross-repo and cross-directory workflow leakage** — an active workflow run in one repo or sandbox no longer blocks or leaks into another when the same workflow ref is used from a different working directory.
- **`show` workflow hints now respect the current scope** — `show workflow:...` only surfaces the active workflow run for the current workspace instead of attaching the latest run from anywhere on the machine.
- **Agent-output and local-model JSON hardening** — reflect/propose and LLM-backed parsing paths are significantly more defensive against malformed JSON and partial local-model output.
- **Reflect draft-file isolation** — reflect no longer writes intermediate draft files into the stash itself; temporary draft output now lives in OS temp space instead of polluting user content.
- **Memory-inference token budgeting** — memory inference now respects the configured LLM token budget instead of overrunning long inputs.
- **Named git stash selectors in `akm save`** — save now resolves named git-backed stash selectors correctly.
- **Indexed script refs in search results** — script entries now surface the correct refs in indexed search results.
- **Feedback ref resolution and LLM indexing regressions** — feedback targeting and related LLM indexing paths were corrected.
- **Release workflow reruns and optional native dependency handling** — release automation is now rerunnable and avoids tripping over optional native dependency edges in CI/publish contexts.
- **Published static-file checks** — migration-help packaging/tests now verify the shipped changelog and bundled release-note files are present and loadable from the published layout.

### Documentation

- **Bundled migration notes now cover 0.7.5** — `akm help migrate 0.7.5` and `akm help migrate latest` now surface the full 0.7.5 operator summary alongside the changelog section.

## [0.7.4] - 2026-05-06

## [0.7.3] - 2026-05-05

### Added

- **`akm index --enrich` opt-in for LLM passes** — index-time enrichment work such as metadata enhancement, memory inference, and graph extraction now runs only when explicitly requested with `--enrich`. Default indexing is faster and no longer surprises operators with LLM-backed work during normal maintenance runs.
- **Config backup snapshots before writes** — config writes now create AKM cache backups so setup/config flows have a recovery path if a config is overwritten or corrupted during development or testing.

### Changed

- **Setup wizard UX refresh** — `akm setup` now better reflects the real configured state: source prompts are ordered more sensibly, configured and preserved stash information is surfaced, agent defaults can be selected explicitly (including disabled), and post-setup indexing does not implicitly enable enrichment.
- **CI workflows updated for current GitHub Actions runtimes** — CI, release, and publishing workflows now use current action majors (`checkout@v5`, `cache@v5`, `setup-node@v5`, `upload-artifact@v5`, `download-artifact@v6`) to stay off deprecated Node 20 action runtimes.
- **Technical investigation notes updated** — the index investigation note now reflects the latest `.stash.json` migration status, current green CI runs, and the narrowed remaining compatibility surface ahead of `v0.8.0`.

### Fixed

- **Embedding-dimension drift on read-only DB opens** — read/telemetry paths no longer mutate the live index schema with the default embedding dimension. `akm info`, search/show parity paths, and related readers now preserve the configured embedding shape instead of downgrading vector tables.
- **Incremental index churn across multiple source layouts** — incremental indexing is now significantly more stable for filename-less legacy metadata, wiki-root sources, repo-root git stash layouts, non-indexed companion files, and cross-source dedupe cases.
- **Git source indexing for repo-root stashes** — git-backed sources no longer assume a `<repo>/content` subtree; repo-root stash layouts are indexed correctly and cached mirrors are treated as fresh instead of being needlessly refreshed.
- **`show` metadata no longer depends on `.stash.json`** — command and skill summary/show metadata now comes from file-local frontmatter and renderer parsing rather than the deprecated disk fallback sidecar.
- **`.stash.json` no longer drives incremental stale detection** — editing `.stash.json` alone no longer forces directories to rescan during incremental indexing.

### Internal

- **Ranking and scoring fixtures migrated toward file-local metadata** — routine benchmark and regression fixtures now prefer markdown frontmatter or inline script metadata, with `.stash.json` retained only for intentional legacy-compatibility coverage that still exercises explicit-file override behavior.
- **Production-path ranking regression coverage** — ranking regression tests now build their fixture index through the production indexer rather than a custom `.stash.json` crawler, reducing fixture drift and improving confidence in the real indexing/search path.

### Added

- **One-shot URL ingest for `akm import` and `akm wiki stash`** — both commands now accept a single HTTP/HTTPS URL in addition to file paths and stdin. `akm import <url>` fetches the exact page, converts it to markdown, and writes it into `knowledge/` using a URL-path-derived default name. `akm wiki stash <wiki> <url>` fetches the exact page, converts it to markdown, and writes it into `wikis/<wiki>/raw/`. Neither command registers a persistent website source or crawls linked pages.

### Changed

- **Shared website ingest boundary** — website URL validation, single-page fetch/convert, and website mirror generation now live in a dedicated shared ingest module. The website source provider is a thin adapter, and `akm add`, `akm import`, and `akm wiki stash` all reuse the same core website-ingest path.
- **`.stash.json` docs deprecation timeline** — the docs now explicitly state that `.stash.json` is deprecated, remains only as a 0.7.x compatibility bridge, and will be removed in v0.8.0 to match the current aggressive pre-release phase-out posture.

## [0.7.0]

### Added

- **Proposal queue (`akm proposal *`)** (#225, #226, #233) — durable queue for proposal-producing commands. New verbs `akm proposal {list, show, diff, accept, reject, revert}`. Promotion runs full validation before routing through `writeAssetToSource()`. Multiple proposals for the same `ref` coexist without filesystem collisions. Auto-accept is gated per-source via `autoAcceptProposals: true` (default off; requires a writable source). See v1 spec §11.
- **`akm reflect`, `akm propose`, `akm distill`** (#225, #226, #227) — three new commands that write **only** to the proposal queue. `reflect` and `propose` shell out via the agent CLI (`agent.*` config); `distill` is the canonical bounded in-tree LLM call gated behind `llm.features.feedback_distillation`. Usage events `reflect_invoked`, `propose_invoked`, `distill_invoked`.
- **`lesson` asset type** (#227) — first-class well-known type with required frontmatter `description` and `when_to_use`, stored under `lessons/<name>.md`. Normally produced by `akm distill <ref>` as a `proposed`-quality proposal and promoted via `akm proposal accept`.
- **`llm.features.*` map with mixed defaults** (#227, #284) — every bounded in-tree LLM call site is gated behind exactly one feature flag. Four keys ship: `curate_rerank`, `feedback_distillation`, `memory_inference`, `graph_extraction`. `memory_inference` and `graph_extraction` default to `true`; the others default to `false`. Wrapper `tryLlmFeature(feature, config, fn, fallback)` in `src/llm/feature-gate.ts` guarantees disabled/throw/timeout fall back without crashing the call site. See v1 spec §14.
- **`quality: "proposed"` and `--include-proposed`** — `SearchHit.quality` open string set; `proposed` is excluded from default search and surfaces only via `akm search ... --include-proposed` or `akm proposal *`. Unknown values parse-warn-include. `SearchHit` gains optional `quality?` and `warnings?` fields.
- **`akm-bench` v1** (#234, PRs #266, #268, #269) — paired-utility benchmark framework. Track A runs each task with and without akm available and emits a comparable score pair; `akm-bench compare` aggregates paired runs into a delta report; `akm-bench attribute` maps utility deltas back to specific `[origin//]type:name` refs (Track B); `akm-bench evolve` is a stub for the closed-loop workflow that lands in 0.8.
- **Operator env-var documentation** (#284 Wave B, PR #285) — `docs/configuration.md` now documents `AKM_NPM_REGISTRY`, `AKM_REGISTRY_URL`, `AKM_CACHE_DIR`, `HF_HOME`, and `GH_TOKEN`.
- **Empty-state hints** (#284 Wave C, PR #286) — `akm proposal list`, `akm workflow list`, and `akm vault list` empty-state messages now include "how to create the first one" guidance.
- **Canned error hints** (#284 Wave C, PR #286) — four new typed error hints added: `INVALID_FLAG_VALUE`, `ASSET_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `FILE_NOT_FOUND`.
- **`--verbose` global flag in `--help`** (#284 Wave C, PR #286) — the flag was honoured at runtime but invisible in help output; now declared.
- **~90 new tests** (#284 Wave D, PR #285) — direct coverage for the proposal/reflect/propose/distill CLI integration paths, output-shape contracts, workflow-runs state machine, and lesson-init scaffolding.

### Security

- **Git message sanitization** (#270) — commit messages and remote URLs written by akm are sanitized to prevent shell-substitution and control-character injection through user-supplied content.
- **Bench env isolation** (#271) — `akm-bench` runs each agent invocation in a scrubbed environment so host secrets do not leak into bench transcripts or paired-run logs.
- **LLM body redact + npm tarball host validation** (#272) — outbound LLM request/response bodies are redacted in error reporting before surfacing to stderr or warnings; `akm add npm:…` validates the tarball download host against the configured npm registry rather than following arbitrary `dist.tarball` URLs.

### Changed

- **Workflow noise gate, sources deprecation warn, setup `--help`** (#273) — `akm workflow next/complete/status` no longer print spurious progress noise on quiet runs; the legacy `stashes[]` key emits a single deprecation warning per process (was: per call site); `akm setup --help` renders the same help block as `akm setup` with no args plus the agent-detection summary.
- **tsconfig + HF pin + shapes throw** (#274) — `tsconfig.json` now includes `tests/` so `bunx tsc --noEmit` covers test files; the HF embeddings model is pinned to a specific revision to avoid silent upstream changes; the output-shape registry throws on a missing shape rather than silently `JSON.stringify`-ing.
- **Bench tmp redirect** (#276) — `akm-bench` no longer writes scratch state under `/tmp`; everything lands under the AKM cache dir (`~/.cache/akm/bench/`) so cleanup is bounded and CI sandboxes that ban `/tmp` writes work out of the box.
- **Registry-build tmp redirect** (#284 Wave E, PR #285) — `inspectArchive` now mkdtemps under `${getCacheDir()}/registry-build/` instead of `os.tmpdir()`. Mirrors the bench-only redirect from #276 for non-bench code. `vault load` retains its `/tmp` mode-0600 sentinel by design.

### Fixed

- **Agent spawn timeout** (#284 Wave A, PR #285, BUG-H1) — stdin write could hang past `agent.timeoutMs`; the write now races against `proc.exited` so the timeout is always honoured.
- **Captured-stdio leak on spawn failure** (#284 Wave A, PR #285, BUG-H2) — stream readers no longer leak as floating promises on the spawn-failed path.
- **`defaultWriteTarget` writability check** (#284 Wave A, PR #285, BUG-H3) — resolving `defaultWriteTarget` was missing the writability gate that the `--target` path enforces; now mirrored.
- **Schema-upgrade row loss** (#284 Wave A, PR #285, BUG-H4) — `restoreUsageEventsBackup` silently dropped rows when the new schema added a NOT-NULL column without DEFAULT; now projects rows onto the column intersection and warns loudly.
- **Bench cleanup registry running flag** (#284 Wave A, PR #285, BUG-H5) — `runAllAndExit` now resets `registry.running` in a `try/finally` so a synchronous throw cannot deadlock subsequent SIGINT handlers.
- **`akm search` with no query** (#284 Wave C, PR #286) — error hint now references `--type`/`--limit` instead of show-style ref grammar.
- **`akm workflow next <bogus-id>`** (#284 Wave C, PR #286) — surfaces `WORKFLOW_NOT_FOUND` with `Run \`akm workflow list --active\`` instead of a cryptic ref-parse error.
- **`akm add /missing/path`** (#284 Wave C, PR #286) — throws typed `NotFoundError("FILE_NOT_FOUND")` with hint instead of a bare `Error`.
- **`akm update <bogus>`** (#284 Wave C, PR #286) — now uses `SOURCE_NOT_FOUND` (with the existing hint pointing at `akm list`) instead of the default `ASSET_NOT_FOUND`.
- **Setup wizard source count + embedding-dim prompt** (#284 Wave C, PR #286) — the wizard now reads `newConfig.sources ?? newConfig.stashes` to count configured sources (was reading the dropped legacy key); the embedding-dimension prompt now explains what the value is for.
- **`formatPlain` null fallback** (#284 Wave C, PR #286) — text renderers now exist for every command that calls `output()`; no more silent JSON when an operator passes `--format text`.
- **Arity guards** (#284 Wave C, PR #286) — `propose`, `feedback`, `curate`, and `help migrate` no longer exit 0 with citty's help screen when required positionals are missing; they now exit 2 with `MISSING_REQUIRED_ARGUMENT`.

### Removed

- **Legacy registry `curated` boolean** — legacy v2 index JSON parses and silently ignores it; renderers no longer surface a `curated` column. The per-asset `quality` field replaces it. Publishers do not need to migrate existing JSON.
- **Phantom config keys** (#284 Wave B, PR #285): `llm.features.{tag_dedup, memory_consolidation, embedding_fallback_score}`, `llm.capabilities.{longContext, toolUse}`, and `llm.contextWindow`. These were parsed and persisted by the loader but never read at any call site, and the docs that described their behaviour were misleading. Operators with these keys in `config.json` will see them silently ignored — `akm config get llm.features.tag_dedup` (etc.) will return undefined.
- **`disableGlobalStashes`** (#284 Wave B, PR #285) — legacy config key removed; the one-cycle deprecation window from the v1 spec has expired.
- **`stashes[]` config-key migration shim** (#284 Wave B, PR #285) — the `stashes[]` → `sources[]` migration was advertised for one release cycle in 0.6.x; that cycle has now expired. 0.5.x configs that have not been touched since will produce a `ConfigError` on parse instead of auto-migrating. Run `akm setup` (or rename the key by hand) to migrate.
- **`searchPaths` legacy migration** (#284 Wave B, PR #285) — pre-0.5.x config key; deprecation window long expired.
- **`context-hub` source-kind migration paths** (#284 Wave B, PR #285) — `STASH_TYPE_ALIASES`, the `parseSourceSpec` `case "context-hub"` arm, the `context-hub-${key}` git rename migration, and the `normalizeToggleTarget("context-hub")` arm are all gone. Per CLAUDE.md, `context-hub` is just a git repo and was never a first-class kind.
- **Legacy lockfile migration** (#284 Wave B, PR #285) — `migrateLegacyLockfileIfNeeded` (the `stash.lock` → `akm.lock` rename) is removed; the rename ran for at least two release cycles.

### Internal

- 9 `console.warn` sites migrated to `warn()` from `src/core/warn.ts` for uniform `--quiet` honoring (#284 Waves A/B, PR #285).
- 6 unused exports removed: `StashLockEntry`, `listProviderTypes`, `resetBuiltinsCache`, and two `GraphRelation` re-exports (#284 Wave A, PR #285).
- ~472 LoC net deletion from `src/core/config.ts` from removing the legacy migration paths above (#284 Wave B, PR #285).
- `--for-agent` deprecation note retained in `docs/technical/akm-core-principles.md` and `docs/technical/search-updated.md` for at least one more cycle.
- Workflow-runs state machine, lesson-init scaffolding, and the proposal/reflect/propose/distill CLI now have direct test coverage (#284 Wave D, PR #285).

### Migration

- See [`docs/migration/release-notes/0.7.0.md`](docs/migration/release-notes/0.7.0.md) for the operator summary and [`docs/migration/v1.md`](docs/migration/v1.md) for the canonical per-surface delta from any 0.6.x baseline.

## [0.6.0] - 2026-04-23

### Added

- **`akm workflow validate <ref|path>`** — new subcommand that validates a workflow markdown file or ref, surfacing every error in one pass (without running a full reindex).
- **`akm feedback` now accepts any indexed ref** — previously type-restricted. `memory:`, `vault:`, `workflow:`, `wiki:` refs all work. Vault feedback never echoes vault values.
- **`akm upgrade` runs post-upgrade tasks automatically.** After a successful upgrade, the new binary is invoked as a child process running `akm index`, which auto-migrates any legacy `stashes` → `sources` config keys via `loadConfig` and rebuilds the index against the new schema (`DB_VERSION` 8 → 9 forces a rebuild). Pass `--skip-post-upgrade` to opt out (config migration still runs on the next `akm` invocation; you'd just need to run `akm index` yourself). Result is reported in the `postUpgrade` field of the upgrade response.
- **`writable` flag on sources.** New optional `SourceConfigEntry.writable` controls whether write commands (`akm remember`, `akm import`, `akm save`, `akm clone`) may target the source. Defaults: `true` for `filesystem`, `false` for `git` / `website` / `npm`. `writable: true` on `website` or `npm` is rejected at config load with `ConfigError("writable: true is only supported on filesystem and git sources")`.
- **`defaultWriteTarget` root config key.** Names the source that receives writes when no `--target` flag is given. Resolution order: `--target` → `defaultWriteTarget` → `stashDir` (working stash) → `ConfigError("no writable source configured; run \`akm init\`")`. There is no implicit "first writable in `sources[]` order" fallback.

### Changed

- **Workflows are now stored as validated `WorkflowDocument` JSON** — workflows are compiled into a validated `WorkflowDocument` JSON shape with line-anchored `SourceRef`s back into the source markdown, cached in a new `workflow_documents` table in `index.db`. The run engine reads from the cache on `akm workflow next` instead of re-parsing markdown each step.
- **Feedback events flow into utility recomputation** — positive/negative feedback signals now feed utility scoring alongside search/show events. Telemetry records both `entry_ref` and `entry_id` so feedback signals survive a reindex.

### Changed (breaking)

- **v1 architecture refactor.** The internal architecture was rebuilt around a single minimal `SourceProvider` interface (`{ name, kind, init, path, sync? }`), a unified FTS5 index that owns search and show, and a single `writeAssetToSource` helper that owns all writes. The CLI command surface and all user-visible config keys are unchanged. See `docs/migration/v1.md` for the full guide.
- **Config key `stashes[]` renamed to `sources[]`.** Configs with the legacy key load with one deprecation warning and are auto-migrated in memory; the new key is persisted on the next `akm config` write. New configs should use `sources[]`. Configs that contain both keys are rejected with `ConfigError`.
- **Error hints surface without `--verbose`.** Error classes own their `hint()` text; the regex-on-message hint chain in `cli.ts` is removed. Hints print to stderr inline alongside the error message.
- **Registry providers loop through a uniform interface.** Context Hub is no longer a special-cased provider type. Add it as a regular git source (`akm add github:andrewyng/context-hub`) or include it as a kit in your registry index. Legacy `type: "context-hub"` entries normalize to `type: "git"` at load time.
- **Terminology cleanup — clean break from "kit" → "stash"** (#148). Pre-v1, no fallback period.
  - **Wire format**: `RegistryIndex.kits[]` renamed to `RegistryIndex.stashes[]`. Schema version bumped to **v3** — `akm-cli >= 0.6.0` only parses indexes with `version: 3`. v1/v2 indexes are no longer accepted. Every static-index registry must regenerate its `index.json` with `version: 3` to be readable. The official `akm-registry` ships a regenerated index alongside this release.
  - **Discovery**: npm packages and GitHub repos are now discovered via the `akm-stash` keyword/topic only. Legacy `akm-kit` and `agentikit` keywords/topics are no longer honored. Publishers must retag.
  - **Schemas**: `schemas/registry-index.json` and `docs/technical/registry-index.schema.json` updated (`RegistryKit` → `RegistryStash`, `kits` → `stashes`).
  - **Internal types**: `RegistryKitEntry` → `RegistryStashEntry`, `InstalledKitEntry` → `InstalledStashEntry`, `KitInstallStatus` → `StashInstallStatus`, `KitSource` → `StashSource`. Files `src/kit-include.ts` → `src/stash-include.ts` and `src/installed-kits.ts` → `src/installed-stashes.ts`.
  - **Asset hit field**: `RegistryAssetSearchHit.kit` → `RegistryAssetSearchHit.stash`.
  - **Docs**: `docs/kit-makers.md` → `docs/stash-makers.md`. All user-facing "kit" references in docs and the README replaced with "stash".
  - **Preserved**: the *Agent Kit Manager* tagline, the `akm-cli` npm package name, and the `akm.include` package.json field.
  - **Migration**: a curated registry author should regenerate their `index.json` (rename `kits` → `stashes`, drop legacy keyword filtering). Publishers should add the `akm-stash` keyword/topic and remove `akm-kit`/`agentikit`.
- **`akm registry` description**: changed from "Manage kit registries" to "Manage stash registries".

### Migration / Breaking

- **`DB_VERSION` bumped 8 → 9.** On first run after upgrade, the version-mismatch path in `ensureSchema()` drops + recreates all `index.db` tables (preserving `usage_events` via a typed backup); the next `akm index` rebuilds the index. `workflow.db` (run state) is unaffected.

### Removed (breaking)

- **OpenViking source provider.** The `openviking` source kind is no longer supported. Configs that contain one fail to load with `ConfigError("openviking is not supported in akm v1. …")` and a hint pointing to `akm config sources remove <name>`. API-backed sources will return as a separate `QuerySource` tier post-v1. To downgrade in the meantime, pin to `akm-cli@0.5`.
- **`akm enable context-hub` / `akm disable context-hub` toggles.** Add Context Hub as a regular git source (`akm add github:andrewyng/context-hub`) or list it as a kit entry in your registry; remove or disable it via `akm config sources remove context-hub` or by editing the entry's `enabled` flag.
- **Legacy re-export shims** `src/llm.ts`, `src/registry-provider.ts`, and `src/ripgrep.ts`. akm has no public API (CLI-only package, no barrel exports), so external consumers should be unaffected.

### Internal

- **`src/` reorganized into purpose-named subdirectories** (`commands/`, `core/`, `indexer/`, `output/`, `registry/`, `setup/`, `sources/`, `wiki/`, `workflows/`). No public API surface change.
- **Single `writeAssetToSource` helper** under `src/core/write-source.ts` is the only place that branches on `source.kind` to add behaviour. All write call sites (`remember`, `import`, `clone`, `save`) route through it.
- **`SourceProvider` interface simplified** to `{ name, kind, init, path, sync? }`. The previous `LiveStashProvider` / `SyncableStashProvider` split is gone.

## [0.5.0] - 2026-04-22

### Added

- **Multi-wiki support** (#119, #121, #136, #139, #144): new `wiki` asset type with ten CLI verbs under `akm wiki …` (`create`, `register`, `list`, `show`, `remove`, `pages`, `search`, `stash`, `lint`, `ingest`). Each wiki lives at `<stashDir>/wikis/<name>/` with `schema.md`, `index.md`, `log.md`, `raw/`, and agent-authored pages. Wiki pages are first-class in stash-wide `akm search`. `akm index` regenerates each wiki's `index.md` as a side effect and is resilient to malformed workflow assets. Raw sources under `raw/` and the `schema.md` / `index.md` / `log.md` infrastructure files are intentionally excluded from the search index. See `docs/wikis.md` for the full guide. Design principle: **akm surfaces, the agent writes** — no LLM calls, no network access; akm owns only operations with invariants an agent can't reliably enforce (lifecycle, raw-slug uniqueness, structural lint, index regeneration, workflow discovery).
- **External wiki registration** (#139, #144): `akm wiki register <name> <path-or-repo>` and `akm add --type wiki --name <name> <source>` register an existing directory or git/website repo as a first-class wiki without copying or mutating it; source and wiki search state are refreshed immediately and refs/state are normalized on subsequent indexing.
- **Workflow asset type** (#118): new `workflow` type with `akm workflow` subcommands `template`, `create`, `start`, `next`, `complete`, `status`, `list`, and `resume` for authoring and stepping through multi-step workflows stored in the stash. Runs snapshot their step list at start so edits to the source workflow do not affect an in-flight run.
- **Vault asset type** (#117): new `vault` type backed by `.env` files; `akm vault` subcommand with `list`, `show`, `create`, `set`, `unset`, and `load` (emits a `source` snippet for the current shell via a mode-0600 temp file); values never appear in structured output.
- **`--trust` flag for installs**: `akm add <source> --trust` performs a one-off trusted install, bypassing the install audit for that source. Blocked install errors now include a `hint` pointing to `--trust` as a remediation option.
- **Writable git stash + `akm save`** (#114): `akm add … --writable` opts a remote git-backed stash into push-on-save; `akm save [name] [-m message]` commits (and pushes when writable + remote is set); default stash is auto-initialized as a git repo; git stash provider now uses `git clone` instead of HTTP tarball download.
- **`akm help migrate <version>`** (#132): prints the release notes and migration guidance for a given version (accepts `0.5.0`, `v0.5.0`, or `latest`). Pulls the matching section from `CHANGELOG.md` when available and supplements it with embedded migration notes for major releases.
- **Broader `akm upgrade` coverage** (#132, #134): self-update now detects and upgrades npm, bun, pnpm, and standalone-binary installs (previously binary-only). Runtime assets covered by the upgrade flow were also expanded so newly shipped asset types stay current.

### Fixed

- **0.5.0 QA follow-ups** (#130): fixes across the new wiki, workflow, vault, and save/trust surfaces surfaced during release-candidate QA.

### Removed (breaking)

- The unreleased single-wiki LLM POC: removes `akm lint` command, `akm import --llm` / `--dry-run` flags, `knowledge.pageKinds` config, and the `ingestKnowledgeSource` / `lintKnowledge` LLM prompts. Users of the POC should migrate to the new `akm wiki …` surface; raw content can be manually moved to `wikis/<name>/raw/`.

### Documentation

- **Technical docs refresh** (#138): stash and search architecture docs updated to match the current implementation.
- **Wiki configuration guide** (#115): new docs page covering wiki configuration and ingest flow.

## [0.4.1] - 2026-04-21

### Added

- **`akm enable` / `akm disable`** (#108): toggle optional components (`skills.sh`, `context-hub`) on/off without manually editing config
- **`akm remember` and `akm import` commands** (#110): capture in-session knowledge directly from the CLI; `akm remember` records a memory to the default stash (supports stdin); `akm import` ingests a file or stdin as a knowledge asset
- **Karpathy-style wiki workflow in knowledge assets** (#113): `akm show knowledge:<doc>` now surfaces an `ingest` workflow for knowledge documents; `--dry-run` flag added; `pageKind` taxonomy made extensible
- Documentation: expanded `agent-install.md`, added `info` and `feedback` command docs, global flags reference (#106)

### Fixed

- Remote embedding endpoint URL normalization — trailing slashes and path segments now handled correctly (#112)
- Reduced fallback capture-name collisions in `akm remember`

## [0.4.0] - 2026-04-19

### Added

- **Install security audit**: new pre-install scanner inspects kit contents for dangerous patterns and executable scripts before install; configurable via `config` CLI
- **Project-level config stash merging**: `.akm.json` in a project directory merges its stash/registry entries with user config during CLI runs
- **Disable inherited project stashes**: project config can disable stashes inherited from parent/user scopes
- **`akm curate` command**: new subcommand for curating assets from the stash (initial skeleton)

### Fixed

- Index nested agent markdown files as agents so `akm search agent:...` finds them
- `install-audit` now reads at most `MAX_SCANNED_FILE_BYTES` per file using `Buffer.alloc`, with the file descriptor always closed via `try/finally`, and corrects the `scannedBytes` counter

## [0.3.1] - 2026-04-01

### Added

- **Website stash provider**: add a URL directly as a stash source with `akm stash add <url>`; crawls the site and indexes pages as knowledge assets
- Website provider options: `--max-pages` and `--depth` flags to bound crawling

### Fixed

- Relaxed HTTP warnings for localhost website sources
- Addressed review feedback around website provider routing and security heuristics

## [0.3.0] - 2026-03-30

### Added

- Regression tests for vector/semantic search readiness, install, and setup flows
- `CONTRIBUTING.md` and "Why akm" section in documentation
- Three draft SEO blog posts

### Changed

- **Unified source model**: replaced the `kit` vs `stash` split with a single source concept; `akm add` works for all source types
- Removed `stash` and `kit` subcommand groups; their behaviors fold into the top-level CLI (`akm list`, `akm add`, etc.)
- Refactored semantic search readiness tracking for clearer state transitions
- Aligned documentation voice and updated older posts for the current CLI surface

### Fixed

- Embedding fingerprint is purged on model change and `usage_events` are re-linked correctly
- Local embedder dtype selection
- Release validation workflow
- Prereleases (versions with suffixes) are marked as such on GitHub releases and published to npm with `--tag next`

## [0.2.2] - 2026-03-28

### Fixed

- Binary install detection in `akm upgrade` self-update; centralized `AKM_VERSION` declaration with binary detection tests

## [0.2.1] - 2026-03-25

### Added

- Docker-based install tests covering multiple OS configurations (skipped in CI)
- Detailed error reporting in embedding availability checks
- Actionable guidance when `sqlite-vec` fails to open the DB

### Changed

- **Rename**: project renamed from `Agent-i-Kit` to `akm` across docs and links
- Local embeddings switched to `@huggingface/transformers`
- `@huggingface/transformers` moved to `optionalDependencies`, then promoted to a runtime dependency
- Improved semantic search setup and index UX

## [0.2.0] - 2026-03-18

### Added

- **Extensible asset type system**: `AkmAssetType` (formerly `AgentIKitAssetType`) is now `string` instead of a fixed union; new types can be registered at runtime via `registerAssetType()`
- **Memory asset type**: built-in `memory` type stored in `memories/`, with `memory-md` renderer and directory/parent-dir-hint matchers
- **OpenViking stash provider**: `openviking` provider type for searching OpenViking servers via REST; add with `akm stash add <url> --provider openviking`
- **Remote show for `viking://` URIs**: `akm show viking://resources/my-doc` fetches content directly from an OpenViking server (returns `editable: false`)
- **`--options` flag** for `akm registry add` and `akm stash add`: pass provider-specific JSON config (e.g., `--options '{"apiKey":"key"}'`)
- **`akm registry build-index` command**: generates a v2 registry index JSON from npm/GitHub discovery with `--out`, `--manual`, `--npmRegistry`, `--githubApi`, and `--format` flags
- Exact-name match, type-relevance, and alias boosts in the search scoring pipeline
- Ranking regression tests with a synthetic fixture stash and a 41-case benchmark suite (MRR / Recall@5)
- `estimatedTokens` on context-hub provider search results and in `--for-agent` output
- Architecture docs and test fixture for OpenViking manual testing (`tests/fixtures/openviking/`)

### Changed

- Unified context-hub indexing and fair provider scoring: local FTS scores are preserved everywhere and remote provider scores compete on equal footing
- Replaced RRF with normalized BM25 scoring across all merge paths
- EMA utility decay is now time-proportional instead of tied to index frequency
- Replaced the `(Bun as any).YAML` hack with a proper `yaml` package dependency
- YAML output format fixed; local registry refs now use a `file:` prefix

### Removed

- `manifest` subcommand (adds no value over `search`)
- URI schemes (`viking://`, `context-hub://`) from user-facing refs — assets are addressed as `type:name`; sources use URLs
- Stale audit/ergonomics markdown from the repo

### Fixed

- `skills.sh` install refs now produce valid `akm add` commands (#82)
- Prevented `akm remove` and `akm update --force` from deleting user-owned local source directories installed via path refs
- `usage_events` reverted to `DELETE` on full reindex

## [0.1.0] - 2026-03-10

Major internal overhaul and rebrand. This release simplifies the asset model,
cleans up the CLI surface, and renames the package from `agent-i-kit` to `akm-cli`.

### Added

- `--verbose` flag on `search` for detailed scoring output
- ExecHints system (`run`, `cwd`, `setup`) for script assets, replacing the old tool-runner
- New environment variable overrides: `AKM_CONFIG_DIR`, `AKM_CACHE_DIR`, `AKM_STASH_DIR`
- CI workflow running lint, type-check, and tests on every push/PR
- Biome linter and formatter configuration
- README badges (npm version, CI status, license)

### Changed

- **Rebrand**: npm package `agent-i-kit` renamed to `akm-cli`; binary remains `akm`
- **Rebrand**: config field `"agent-i-kit"` renamed to `"akm"` in `package.json`
- **Rebrand**: plugin `agent-i-kit-opencode` renamed to `akm-opencode`
- **Rebrand**: registry `agent-i-kit-registry` renamed to `akm-registry`
- **Rebrand**: default paths changed (`~/agent-i-kit` to `~/akm`, `~/.config/agent-i-kit` to `~/.config/akm`)
- **Rebrand**: environment variables `AGENT_I_KIT_*` renamed to `AKM_*`
- Removed `tool` asset type entirely; `script` is the only script-like type
- `.stash.json` field renames: `intents` to `searchHints`, `entry` to `filename`; removed `generated` boolean
- `show` command: `--view` flag replaced with positional syntax (`akm show <ref> toc`)
- Collapsed `AssetTypeHandler` handlers into a unified renderer pipeline
- Dropped provider presets (raw JSON config only)
- Pinned `sqlite-vec` to exact version `0.1.7-alpha.2` (removed caret range)
- Replaced `(Bun as any).YAML` cast with proper type guard in CLI
- Version now injected at compile time via `--define AKM_VERSION` with safe runtime fallback

### Removed

- `submit` command
- Provider presets (configure providers with raw JSON)
- `generated` boolean from `.stash.json`

### Fixed

- CLI crash on macOS when running as compiled binary (`package.json` not embedded)
- Cleaned up search output formatting

## [0.0.17] - 2026-03-12

Registry refactor and documentation overhaul. This release introduces a
first-class registry management CLI, modernizes the config schema, and
rewrites all documentation against the final asset model.

### Added

- `akm registry` subcommand group with `list`, `add`, `remove`, and `search` subcommands
- `akm registry search --assets` flag for asset-level search against v2 registry indexes
- `registries` config field (`RegistryConfigEntry[]`) with `url`, `name`, and `enabled` properties
- Registry Index v2 schema with optional `assets` array on kit entries for asset-level discovery
- Official registry pre-configured by default in new installations
- Type names: `KitSource`, `InstalledKitEntry`, `KitInstallResult`, `KitInstallStatus`, `InstalledKitListEntry`

### Changed

- Config: `installed` is now a top-level field (`config.installed`) instead of nested under `config.registry.installed`
- Config: registry URLs configured via `registries` array instead of `registryUrls`
- Documentation: complete rewrite of concepts, registry, CLI reference, README, and all technical docs
- Documentation: added "Mental Model" (registries --> kits --> stash --> assets) to concepts
- Documentation: added asset classification taxonomy description
- Documentation: merged ref format documentation into concepts (removed "opaque handle" framing)
- Documentation: revised apt analogy in core principles to map registries, kits, stash, and assets
- Documentation: added `akm registry` subcommand group to CLI reference
- Documentation: added registry hosting and v2 index format guides

### Removed

- `tool` asset type (fully removed across all documentation and code)
- `registryUrls` config field (replaced by `registries`)
- `config.registry.installed` nesting (replaced by `config.installed`)
- All `tools/` directory references from documentation

## [0.0.13] - 2026-03-09

Initial public release of Agent-i-Kit (`akm` CLI).

### Added

- CLI tool (`akm`) for searching, showing, and running Agent-i-Kit stash assets
- Hybrid search with FTS5 full-text and optional vector similarity scoring
- Registry support for discovering, installing, and updating community kits
- Multiple install sources: npm, GitHub, git URLs, and local directories
- Self-update via `akm upgrade`
- Multiple output formats: plain text, YAML, and JSON (`--json`)
- Knowledge asset navigation with TOC, section, and line-range views
- `akm clone` to fork installed assets into your working stash
- Configuration system with embedding and LLM provider management
- Standalone binary distribution (no runtime dependencies)
