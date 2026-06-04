# Proposal-Queue Triage — Implementation Plan

Status: proposed
Author: design synthesis (skeptic-reviewed)
Target: 0.8.x (additive, opt-in) → cleanup in 0.9.0

## 1. Goal

Make automatic proposal-queue management a **user-controllable, config-driven
capability** — enabled and tuned the way other improve behaviour is — without
the bespoke hand-rolled cron task that exists today
(`process-proposals` at `20 * * * *`, which dispatches a full agent session
running the `manage-akm-proposals` skill + a `contradicted` rubric memory).

The replacement must:

- drain the **standing pending backlog** (the auto-accept gate only covers a
  run's *fresh* proposals), and
- be deterministic for the common case (no LLM required), with an **optional
  judgment tier** (`llm` default, or `agent`/`sdk`) for the
  genuinely-judgmental tail, and
- ship with **hard data-safety guardrails** (promotion commits to git; a
  per-proposal `akm proposal revert` exists — `revertProposal`/`akmProposalRevert`,
  restoring the backup `promoteProposal` captures at promotion time — but there
  is **no batch revert**, so a wrong bulk drain must be undone one id at a time;
  verified against src/core/proposals.ts).

## 2. Design decisions (locked, with rationale)

These were settled in an adversarial review (architecture / data-safety /
simplicity skeptics). See §9 for the rejected alternatives.

1. **Triage IS a first-class improve process (`processes.triage`), configured
   exactly like the other full-pass processes.** An earlier draft rejected this
   ("every process is per-ref") — that premise was wrong. `consolidate`,
   `memoryInference`, and `graphExtraction` already operate on their own
   candidate sets, not `plannedRefs`, and `ImproveProcessConfig.allowedTypes` is
   documented as *"Only applied by per-ref processes (reflect, distill); ignored
   by full-pass operations."* The config shape is built for exactly this.
   Triage-specific fields (`policy`, `applyMode`, `maxAcceptsPerRun`,
   `maxDiffLines`, `rejectEmpty`, `judgment`) follow the established
   process-specific-field precedent (`contradictionDetection` is consolidate-only;
   `defaultSince`/`maxTotalChars`/`maxChunkSize` are extract/consolidate-only).
   Making triage a process gives the user what they asked for: profiles can
   tune it and include/exclude it alongside reflect/distill/etc., and per-profile
   dials directly de-risk the run (see the risk→dial mapping in §16). The
   `akm proposal drain` verb (§3.1) remains as the underlying engine the process
   calls. **Scope guard:** triage only fires on whole-stash / type-scoped runs
   (`scope.mode !== "ref"`); a single-ref `akm improve skill:x` logs a skip
   rather than draining the whole queue.

2. **Backlog-only. Never re-adjudicate this run's fresh proposals.** The
   per-run auto-accept gate (`runAutoAcceptGate`) already judged fresh proposals
   by *confidence*. Triage judges by *generator + diff-size*. If both touch the
   same proposal, the coarser diff-size rule silently overrides a deliberate
   confidence rejection. Triage must filter out fresh ids — mirroring the
   existing extract backlog drain at `src/commands/improve.ts:1406-1422`
   (the gating `if` is at `:1410`; verified against src/commands/improve.ts).

3. **Recommended default: triage is a PRE-pass folded inside `akm improve`; a
   standalone task is optional.** The original "schedule it separately" advice
   was really "don't fold it as a *tail* step" — a tail step binds triage to
   improve's `budgetMs` abort scope, so a timed-out improve would never drain.
   Running it *before* improve dissolves that objection (triage runs first,
   before any budget pressure). The pre-pass is also the only arrangement that
   closes the proposals-concurrency hazard (§15, risk 1): it runs under
   `improve.lock`, fully serialized against improve's own queue writes. A
   chained `bash -c "akm proposal drain … ; akm improve …"` command task is a
   valid zero-integration stopgap but is NOT under the lock and shares one
   timeout. A fully separate scheduled task is only warranted when an
   independent drain cadence is required. See §15 for the full comparison.

3a. **Triage runs BEFORE improve, not after.** (See §13 for the full
   investigation.) The `createProposal` dedup guard
   (`src/core/proposals.ts:501-520`, inside the `if (!input.force)` block that
   spans `:491-553`; verified against src/core/proposals.ts) skips a fresh
   proposal as `duplicate_pending` when a *stale* pending proposal already
   exists for the same `ref+source` — the stale one wins, the fresh analysis is
   discarded.
   Draining the backlog first clears the queue so improve generates fresh
   proposals with no collision; improve's existing top-of-run `ensureIndex`
   (`improve.ts:793`) absorbs triage's promotions for free; and triage's
   fresh-exclusion set is empty (no fresh ids exist yet). Running after would
   throw away improve's freshly-computed proposals and re-accept stale content.
   When the two are separate cron tasks, schedule triage a few minutes before
   improve (e.g. triage `:00`, improve `:10`).

4. **Deterministic core needs no LLM; the judgment tier supports `llm | agent |
   sdk` exactly like improve processes.** Today's rubric maps entirely to
   existing flags (`--generator`, `--max-diff-lines`, `--older-than`). The
   judgment tier is reserved for the irreducibly-semantic tail (consolidate
   mid-band, distill duplicate detection, contradiction escalation). It reuses
   the existing `RunnerSpec` union and `resolveImproveProcessRunnerFromProfile`,
   so `mode: llm` is fully supported — not just `agent`. See §14.

5. **Safe by default.** First-enable default is `applyMode: queue`
   (stage/reject-empty only; never calls `promoteProposal`). Entering
   `applyMode: promote` requires an explicit non-default config value. Hard
   per-run accept ceiling enforced in code. The `contradicted` rubric is shipped
   as an *editable preset*, never hardcoded. (`applyMode` is a triage-specific
   field, distinct from the generic process `mode: llm|agent|sdk`, which on
   triage applies only to the nested `judgment` runner.)

## 3. User-facing surface

### 3.1 New command

```
akm proposal drain [--policy <preset>] [--dry-run] [--yes]
                   [--max-accepts <N>] [--max-diff-lines <N>] [--older-than <days>]
                   [--judgment]            # opt into the judgment tier (llm by default; agent/sdk if so configured)
                   [--profile <improve-profile>]   # read triage block from this profile
```

- `--dry-run` lists what would be accepted/rejected/deferred; no writes.
- `--yes` required in non-interactive mode for any promotion (matches existing
  bulk-accept).
- `--judgment` enables the judgment tier (resolves to `llm` by default, or
  `agent`/`sdk` per the configured `judgment.mode`); no-op with a logged
  `triage_deferred` summary when no runner is configured.

Built-in policies (the *only* "rule schema" we ship):

| preset           | accepts                                                        | rejects        | leaves pending                          |
|------------------|---------------------------------------------------------------|----------------|------------------------------------------|
| `personal-stash` | extract (real content); reflect ≤80 lines; consolidate ≤ band | empty diffs    | consolidate mid-band, distill dups, contradictions |
| `conservative`   | small extract + consolidate only                              | empty diffs    | everything else                          |
| `manual`         | nothing                                                       | empty diffs    | everything else                          |

`personal-stash` encodes the deterministic core of today's rubric. Custom needs
are served by `--policy <path-to-file>` (one escape hatch), not by a rule engine.

### 3.2 Config: `triage` is a first-class improve process

`triage` lives under `processes`, alongside `reflect`/`distill`/`consolidate`/
`memoryInference`/`graphExtraction`/`validation`/`extract`, so it is tuned,
included, and excluded the same way as any other improve process:

```yaml
profiles:
  improve:
    default:
      processes:
        reflect: { enabled: true }
        distill: { enabled: true }
        triage:                  # ← just another process entry
          enabled: false         # opt-in; mirrors the `validation` precedent
          applyMode: queue       # queue (safe default) | promote
          policy: personal-stash
          maxAcceptsPerRun: 25    # hard cap, enforced in code
          maxDiffLines: 200
          rejectEmpty: true
          judgment:              # OPTIONAL judgment tier
            mode: llm            # llm (default) | agent | sdk  (the generic process runner mode)
            profile: <profile-name>
            timeoutMs: 600000
```

Because it is a normal process, all the existing profile machinery applies for
free:

- **Include / exclude per profile** — `quick` and `memory-focus` ship with
  `triage: { enabled: false }`; `thorough` ships with `triage: { enabled: true }`.
  Users flip it in their own profiles like any other process.
- **`akm improve --profile <name>`** selects a profile whose process set
  includes or excludes triage — e.g. a dedicated `triage-only` profile
  (everything else disabled) run on its own schedule gives an independent drain
  cadence without a separate verb.
- **Resolution** goes through the same `resolveProcessEnabled("triage", profile)`
  and `deepMerge` paths as every other process (`src/commands/improve-profiles.ts`).

**Triage-specific fields** (analogous to extract's `defaultSince`/`maxTotalChars`):
`applyMode`, `policy`, `maxAcceptsPerRun`, `maxDiffLines`, `rejectEmpty`,
`judgment`. The generic `allowedTypes` is ignored (as it is for all full-pass
processes). The generic `mode`/`profile` fields are *not* used at the top level
for triage — its only runner is the nested `judgment` tier.

`judgment.mode` accepts the same three values as any improve process and is
resolved through the same `resolveImproveProcessRunnerFromProfile` path:
- `llm` — in-tree HTTP call (`chatCompletion`), no filesystem. The engine
  pre-fetches the live asset + sibling pending proposals into the prompt; the
  model returns a verdict. Sufficient for mid-band accept/reject and
  judge-against-provided-context dedup. Cheapest; the default.
- `agent` / `sdk` — spawns a CLI/SDK with tool access. Use when the verdict
  needs *autonomous cross-stash investigation* — e.g. searching the whole stash
  for contradictions, or dedup against assets not in the provided context.

Discovery/control: because `triage` is a normal process, it round-trips through
config for free — `akm config get profiles.improve.<name>.processes.triage`
shows the effective settings with zero new wiring. Surfacing it in
`akm tasks doctor` is *not* automatic (the `TasksDoctorResult` struct,
`src/commands/tasks.ts:405-413`, is a fixed shape with no improve-process
field); see §6 for the small explicit work item that adds it.

### 3.3 Scheduled task (replaces the `:20` prompt task)

A `command:` task generated from config instead of the bespoke agent prompt:

```yaml
# tasks/process-proposals.yml (regenerated)
schedule: 20 * * * *
command: akm proposal drain --policy personal-stash --yes
enabled: true
name: Drain AKM proposal queue
```

**Environment facts (verified on host, 2026-06-02 — these are user/generated
config, not repo source):**
- `~/akm/tasks/process-proposals.yml` exists: `schedule: 20 * * * *`, a `prompt:`
  target invoking `skill:manage-akm-proposals` against the queue. Cron line:
  `20 * * * * … dist/cli.js tasks run process-proposals`.
- `~/akm/tasks/akm-improve.yml`: `command: akm improve --auto-accept 90
  --timeout-ms 1620000`, `timeoutMs: 1800000`, schedule `7,37 * * * *`. The
  `--timeout-ms 1620000` (27 min ≈ 90% of the 30-min cron ceiling) is the
  graceful-exit tuning §15 risk 2 refers to.
- Both are this user's personal-stash config; another user's host will differ.
  The migration (§11) regenerates the `process-proposals` task or folds triage
  into the improve profile (decision #3).

## 4. Architecture & data model

### 4.1 New module: `src/commands/proposal-drain.ts`

Pure engine, file-injectable seams for tests (mirrors `improve-auto-accept.ts`).

```ts
export interface DrainPolicy {
  name: string;
  accept: Array<{ generator: string; maxDiffLines?: number; minContentLines?: number }>;
  rejectEmpty: boolean;
  // generators whose mid-band / ambiguous items are deferred to the judgment tier
  defer: string[];
}

export interface DrainOptions {
  stashDir: string;
  policy: DrainPolicy;
  applyMode: "queue" | "promote";
  maxAccepts: number;
  dryRun: boolean;
  excludeIds?: Set<string>;       // fresh-this-run ids (decision #2)
  judgment?: RunnerSpec | null;   // judgment tier (llm | agent | sdk)
  eventsCtx?: EventsContext;
}

export interface DrainResult {
  promoted: string[];
  rejected: string[];
  deferred: Array<{ id: string; reason: "mid-band" | "possible-dup" | "possible-contradiction" }>;
  skippedByCap: string[];
}

export async function drainProposals(opts: DrainOptions): Promise<DrainResult>;
```

Reuses:
- `listProposals(stashDir, { status: "pending" })` (`src/core/proposals.ts:593`).
  NOTE: `listProposals` filters by `includeArchive`/`status`/`ref`/`type` only —
  there is **no `source` filter argument**. Filtering by generator/source must
  be done in-memory on the returned array (as `createProposal` and the bulk-accept
  path already do). (verified against src/core/proposals.ts:593-595)
- `akmProposalAccept` (which calls `promoteProposal` at `src/core/proposals.ts:962`
  and emits the `promoted` event) — these wrappers live in
  **`src/commands/proposal.ts`** (`akmProposalAccept` at `:122`,
  `akmProposalReject` at `:171`), *not* in `src/core/proposals.ts`. Prefer the
  `akmProposalAccept`/`akmProposalReject` wrappers so the `promoted`/`rejected`
  events are emitted; or call `promoteProposal` directly and emit events
  yourself. The `runAutoAcceptGate` path (`src/commands/improve-auto-accept.ts:93`)
  is confidence-gated and is NOT a drop-in for generator/diff-size promotion —
  reuse the wrapper, not the gate.
- `akmProposalReject` (`src/commands/proposal.ts:171`) for empty diffs.
- `resolveImproveProcessRunnerFromProfile` (`src/integrations/agent/runner.ts:168`)
  for the judgment tier. NOTE: this resolver returns `null` when the entry sets
  neither `mode` nor `profile`; to honor `judgment.mode: llm` defaulting to
  `defaults.llm`, wrap it the way `resolveValidationRunner`
  (`src/integrations/agent/runner.ts:136-156`) does. (verified)

### 4.2 Built-in policy presets: `src/commands/proposal-drain-policies.ts`

`PERSONAL_STASH`, `CONSERVATIVE`, `MANUAL` as exported `DrainPolicy` constants.
`personal-stash` carries the editable note that it encodes a personal-stash
rubric (the `contradicted` memory). `--policy <path>` loads + zod-validates a
custom file.

### 4.3 Guardrails (enforced in code, not config hints)

- **Per-run accept ceiling** — `maxAccepts` checked *before* the promotion loop;
  remainder lands in `skippedByCap` and is logged.
- **Diff-line bound** — accepts above `maxDiffLines` are deferred, never
  promoted (no silent large rewrites).
- **`applyMode: queue` is the default** — promotion path is gated on
  `applyMode === "promote"`; entering promote mode logs on every run:
  `[triage] auto-promote active: <N> accepts allowed this run`.
- **Re-accept churn — already mitigated; no new cooldown code required.** The
  worry was a twice-hourly loop: triage accepts `reflect:X` → improve regenerates
  `reflect:X` next run → triage re-accepts, 48×/day. **The 0.8.0 signal-based
  gate already prevents this.** Flat time cooldowns were replaced by a "new
  signal since last proposal" gate (`src/commands/improve.ts:655-657`); a ref
  with no fresh signal since its last proposal is skipped with
  `result: { ok: true, reason: "no new signal since last proposal" }` (`:1662`).
  So after triage promotes `reflect:X`, improve will *not* regenerate it next run
  unless new feedback/retrieval signal has landed — the loop cannot spin. Triage
  is also backlog-only (decision #2) and runs as a pre-pass, so it never re-sees
  a proposal improve just generated in the same run.
  - **Optional belt-and-suspenders (only if a source proves churny in practice):**
    add an accept-recency guard, and — unlike the earlier draft's claim — we
    **can** distinguish auto from manual accepts. The `promoted` event carries
    `autoAccept: true` when the gate fired (`improve-auto-accept.ts:129`) and
    omits it for manual `akm proposal accept` (`src/commands/proposal.ts:133`).
    Query it the way improve already loads rejected events into a Map
    (`improve.ts:984`, `readEvents({ type: "proposal_rejected", since })`):
    `readEvents({ type: "promoted", since })`, keep entries with
    `metadata.autoAccept === true`, and suppress re-queue of that `ref+source`
    within the window. This gates on *auto-accept* recency only, so manual
    accepts never block a user's own re-proposal. Do **not** scan archived
    `status:"accepted"` proposals — `ProposalReview` (`proposals.ts:173-177`) has
    no provenance field, so that path cannot tell auto from manual.

### 4.4 Events / observability

- `triage_drained` — `{ promoted, rejected, deferredByReason, skippedByCap, policy, applyMode }`
- `triage_deferred` — emitted when the deterministic tier leaves items for
  judgment and no runner is configured, so "enabled, no agent" never *looks*
  like full success.
- Reuse the existing `promoted` event shape from `runAutoAcceptGate` for each
  promotion (keeps `akm health` rollups working).

## 5. Config schema changes

Triage is a process, so the changes extend the existing process plumbing rather
than adding a parallel structure.

### `src/core/config-schema.ts`

- Extend `ImproveProcessConfigSchema` (`:141`) with the triage-specific optional
  fields — `applyMode: z.enum(["queue","promote"])`, `policy: z.string()`,
  `maxAcceptsPerRun: positiveInt`, `maxDiffLines: positiveInt`,
  `rejectEmpty: z.boolean()`, and `judgment` (a nested object, itself `.strict()`,
  of `{ mode: z.enum(["llm","agent","sdk"]).optional(), profile: z.string().optional(),
  timeoutMs: z.union([positiveInt, z.null()]).optional() }`). This schema is
  declared with **`.strict()`** (`:155`; verified), so adding these fields to the
  shared object is *required* — strict would otherwise reject them. This mirrors
  how extract-only (`defaultSince`, `maxTotalChars`) and consolidate-only
  (`maxChunkSize`, `contradictionDetection`) fields already live on the shared
  schema, each "only meaningful on" its process.
- Add `triage: ImproveProcessConfigSchema.optional()` to
  `ImproveProfileProcessesSchema` (`:157`). NOTE: this schema uses
  **`.passthrough()`** (`:166`), not `.strict()`; unknown process keys are
  rejected by the `superRefine` `allowed` set, not by strict object parsing
  (verified).
- Add `"triage"` to the `allowed` key set inside that schema's `superRefine`
  (the `Set` is declared at `:180-188`; the unknown-key loop is `:189-197`;
  verified). `extract` is already accepted this way despite also being a named
  field, so the named-field + allowed-set combination is the established pattern.
  (The `feedbackDistillation` removal check at `:171-179` is unaffected.)

### `src/core/config-types.ts`

- Add the triage-specific fields to `ImproveProcessConfig` (`:113`) with
  docstrings noting "Only meaningful on the `triage` process" (matching the
  existing per-process-field convention).
- Add `triage?: ImproveProcessConfig` to `ImproveProfileConfig.processes`
  (`:160`).

### `src/commands/improve-profiles.ts`

- Add `triage: false` to `IMPROVE_PROCESS_DEFAULTS` (`:76`) — opt-in like
  `validation`, so `resolveProcessEnabled("triage", profile)` works with no
  config and defaults off.
- Add `triage` entries to the built-in profiles (`BUILTIN_PROFILES`, `:21`):
  `default` → `{ enabled: false, applyMode: "queue", policy: "personal-stash" }`;
  `quick`/`memory-focus` → `{ enabled: false }`; `thorough` →
  `{ enabled: true, applyMode: "queue" }`. (Users override per profile.)
- `triage` needs no `DEFAULT_ALLOWED_TYPES` entry (full-pass process; it ignores
  `allowedTypes`, same as `memoryInference`/`graphExtraction`).

## 6. CLI wiring (`src/cli.ts`)

- New `proposalDrainCommand` (`defineCommand`) added to `proposalCommand.subCommands`
  (the `subCommands` object is at `src/cli.ts:3877`; verified), alongside the
  existing `list`/`show`/`diff`/`accept`/`reject`/`revert`.
- Resolve policy: `--policy <preset|path>` → `DrainPolicy`; when `--profile` is
  given, read `resolveImproveProfile(name).processes.triage` and merge its
  fields (`applyMode`, `maxAcceptsPerRun`, `maxDiffLines`, `judgment`). CLI flags
  override config.
- Confirmation: reuse `confirmDestructive` from `src/cli/confirm.ts` (same as
  bulk-accept at `:3600`).

### 6.1 `tasks doctor` surfacing (small, explicit — not free)

`TasksDoctorResult` (`src/commands/tasks.ts:405-413`) is a fixed struct with no
improve-process field, so surfacing triage there is a deliberate addition, not
automatic:
- Add an `improveTriage?: { defaultProfile: string; enabled: boolean;
  applyMode: string; policy: string }` field to `TasksDoctorResult`, populated in
  `akmTasksDoctor` (`:415`) from `resolveImproveProfile(config.defaults?.improve,
  config).processes?.triage`.
- Render it in the `tasks-doctor` output shape.
This is the only "discovery" wiring; `akm config get` already works without it.

The primary path: `akmImprove` calls `drainProposals` as a **pre-pass** when
`resolveProcessEnabled("triage", improveProfile)` is true and
`scope.mode !== "ref"` (see §13 for ordering rationale, §15 for why this beats a
separate task). NOTE (verified against src/commands/improve.ts): `resolveProcessEnabled`
(`improve-profiles.ts:95`) is the *right* gate for triage because triage defaults
**off** (`IMPROVE_PROCESS_DEFAULTS.triage = false`, so it needs an explicit
`=== true`). This differs from how the existing full-pass processes are gated —
`consolidate`/`memoryInference`/`graphExtraction` use inline
`improveProfile?.processes?.X?.enabled === false` checks (`improve.ts:2537`,
`:2754`, `:2796`) because they default **on**. So triage is gated like
`validation` (opt-in), not like the always-on full-pass siblings. The triage
process config is read off the already-resolved `improveProfile.processes.triage`;
the judgment runner (if any) comes from
`resolveImproveProcessRunnerFromProfile(improveProfile.processes.triage.judgment, config)`.

### Required startup-ordering refactor

Today `akmImprove` runs `ensureIndex` (`improve.ts:793`), `collectEligibleRefs`
(`:822`; the plan previously said `:816`), the contradiction-detection pass
(`detectAndWriteContradictions`, `:835`) and `analyzeMemoryCleanup` (`:842`),
and the **dry-run early return** (`:850-863`) **before** it sets up and acquires
`improve.lock` — `acquireLock()` is *called* at `:920` (the `:916` anchor lands
inside a `throw` in the lock body, not the call site; verified). For triage to
run *under the lock* AND have its promotions reflected in the index and
eligibility scan, hoist the lock:

```
1. resolveImproveProfile
2. (dry-run? compute plannedRefs/memorySummary and early-return WITHOUT lock or triage)
3. acquireLock()                      # HOISTED above ensureIndex (non-dry-run only)
4. triage (drainProposals)            # only if resolveProcessEnabled(triage) && scope!=ref;
                                      #   excludeIds is empty (no fresh ids yet)
5. ensureIndex                        # now picks up triage's promotions
6. collectEligibleRefs                # sees post-triage, un-blocked queue
7. contradiction-detection + memory-cleanup analysis (currently between
                                      #   collectEligibleRefs and the lock — they
                                      #   move below the lock for free with the hoist)
8. reflect/distill/consolidate loop + auto-accept gate
```

This is a modest but real refactor — call it out in the PR. **Two ordering
hazards to preserve (verified against src/commands/improve.ts):** (a) Today
`ensureIndex` (`:793`) and `collectEligibleRefs` (`:822`) run *before* the
dry-run early-return (`:850-863`), and the lock is acquired *after* it (`:920`).
If the lock is hoisted above `ensureIndex`, the dry-run branch must be guarded so
it still produces `plannedRefs`/`memorySummary` **without** acquiring the lock or
running triage (i.e. gate lock+triage on `!options.dryRun`). (b) The lock body
includes stale-lock recovery (probe + `improve_lock_recovered` event,
`:890-913`); none of it depends on `ensureIndex` having run, so the hoist is
safe — but the PR must move the **entire** lock-setup block (`resolvedLockPath`
+ `MAX_LOCK_AGE_MS` + the `acquireLock` definition, `:865-919`) together with the
`acquireLock()` call at `:920`, not just the call.

### Failure isolation

Wrap the triage pre-pass in try/catch and treat failure as a non-fatal warning
(mirroring the existing contradiction-detection pass), so a drain error never
aborts the improve run.

### Budget

Because triage is a pre-pass it runs before `budgetAbortController` pressure
matters for improve's own loop — but its judgment-tier time still counts against
the single cron `timeoutMs`. Give `drainProposals` its own internal timeout
(`triage.judgment.timeoutMs`) so a slow tier cannot starve the reflect loop
(§15, risk 2).

## 8. Test plan

New / extended tests (Bun, mirror `tests/improve-auto-accept.test.ts`):

- `tests/proposal-drain.test.ts`
  - policy matching: extract→accept, empty-diff→reject, mid-band consolidate→defer
  - `excludeIds` filters fresh proposals (decision #2 regression guard)
  - `maxAccepts` ceiling stops promotion and reports `skippedByCap`
  - `applyMode: queue` never calls the injected `promoteFn`
  - `maxDiffLines` defers large proposals
  - `--dry-run` performs zero writes (assert injected promote/reject not called)
- Re-accept churn regression (see §4.3): assert that a ref promoted by triage is
  *not* re-proposed by reflect absent a new signal — i.e. the existing
  "no new signal since last proposal" gate (`improve.ts:1662`) already covers it,
  so no new cooldown test is needed. Only if the optional auto-accept-recency
  guard is built: a unit test that a `promoted` event with
  `metadata.autoAccept === true` suppresses re-queue while a manual `promoted`
  (no flag) does not.
- `tests/config-*.test.ts` — `triage` block under `processes` parses and is
  **accepted** (it is added to the `allowed` set, §5); the triage-specific
  fields validate on `ImproveProcessConfigSchema`; genuinely unknown process
  keys are still rejected by the `superRefine`.
- CLI integration — `akm proposal drain --policy personal-stash --dry-run`
  against a seeded queue produces the expected envelope.

## 9. Rejected alternatives (and reversed decisions)

- **`rules` rule-engine inside the config.** An ordered generator+diff-band
  mini-language reinvents existing CLI flags in YAML. Rejected — ship built-in
  `policy` presets + a `--policy <path>` escape hatch instead.
- **REVERSED — "triage is not a process, make it a profile-level sibling."** An
  earlier draft rejected `processes.triage` on a "every process is per-ref"
  premise. That premise is false (`consolidate`/`memoryInference`/
  `graphExtraction` are full-pass; `allowedTypes` is documented as ignored by
  full-pass processes). Triage is now a first-class process (decision #1, §3.2),
  which is what the user wants for tunability/include-exclude parity. The
  per-ref hazard is handled by the `scope.mode !== "ref"` guard, not by
  relocating the config.
- **Fold drain as a *tail* step and retire the `:20` task outright.** A tail
  step couples to `budgetMs`; the queue never drains on timeout days. Rejected —
  triage is a *pre*-pass (§7, §15), which avoids this entirely.
- **Auto-promote by default.** The rubric is `contradicted`; promotion commits
  to git with no batch-revert. Rejected — `applyMode: queue` is the default.

## 10. Phasing / sequencing

1. **Phase 1 — deterministic engine + verb.** `proposal-drain.ts`,
   presets, `akm proposal drain`, guardrails (ceiling, diff-bound, queue
   default), events, tests. Pure deterministic; delivers ~90% immediately.
2. **Phase 2 — config block + UX.** `triage` schema, `--profile` merge,
   `tasks doctor` surfacing. Regenerate the `:20` task as a `command:` task.
3. **Phase 3 — judgment tier (`llm`/`agent`/`sdk`).** Wire `judgment` runner for
   mid-band/dups/contradictions; `triage_deferred` when absent.
4. **Phase 4 — optional improve integration + retire the bespoke prompt task**
   once the command task demonstrably drains the queue (including on
   improve-timeout days).

## 11. Migration & cleanup

- 0.8.x: ship Phases 1–3 additively. Old `process-proposals.yml` keeps working;
  document the `command:`-task replacement.
- 0.9.0: remove the `manage-akm-proposals`-driven prompt-task guidance from
  setup/docs; the deterministic verb + optional agent tier is the supported path.

## 12. Open decisions for the maintainer

- **Default mode** — recommend `queue`; choosing `promote` to match today's
  behaviour widens blast radius.
- **Folded pre-pass vs separate task** — recommend the folded pre-pass
  (Approach A, §15) as default; a separate task only when an independent drain
  cadence is needed.

## 13. Investigation: should triage run before or after improve?

**Conclusion: BEFORE.** Schedule the standalone task a few minutes ahead of
improve (e.g. triage `:00`, improve `:10`); when folded, run it as a pre-pass
(§7).

### The deciding mechanism: the `duplicate_pending` dedup guard

`createProposal` (`src/core/proposals.ts:491-520`) refuses to enqueue a new
proposal when a pending one already exists for the same `ref+source`:

- identical content → silent skip (`content_hash_match`)
- **different content → skip with `reason: "duplicate_pending"`** — the existing
  (stale) pending proposal stays; the new one is dropped unless `force: true`.

So a stale pending proposal **blocks** a fresh re-analysis of the same asset.

### Why "after" is harmful

Lifecycle of an improve run: reflect/distill/consolidate/extract create
proposals; the per-run auto-accept gate promotes the fresh high-confidence ones;
an extract backlog drain already runs at end-of-run
(`improve.ts:1406-1422`; it filters `source === "extract"` proposals NOT in this
run's `freshIds`, and is gated by `options.autoAccept !== undefined`; verified).
Anything not auto-accepted stays pending = the backlog.

If triage runs **after** improve:
1. The backlog still contains a stale pending `reflect:X` from a prior run.
2. Improve's reflect re-analyzes `X` and calls `createProposal` → the guard
   sees the stale pending entry → **the fresh proposal is discarded**
   (`duplicate_pending`). The LLM tokens spent generating it are wasted.
3. Triage then drains the backlog and may **accept the stale `reflect:X`** — so
   the stash is updated from outdated analysis while the fresh one is gone.

This is precisely the "duplicate proposals / wasted work" failure the question
asks to prevent.

### Why "before" is strictly better

1. Triage drains the backlog first → the pending queue for `X` is cleared
   (accepted/rejected) or explicitly deferred.
2. Improve's existing top-of-run `ensureIndex` (`improve.ts:793`, already runs
   before `collectEligibleRefs`) re-indexes any assets triage just promoted — no
   extra reindex needed.
3. Reflect re-analyzes `X` against **current** state and enqueues a fresh
   proposal with **no `duplicate_pending` collision**.
4. Triage's fresh-exclusion set (decision #2) is empty pre-improve, so the
   engine is simpler and there is zero double-adjudication risk.

### Residual consideration

Triage-before that *promotes* a backlog item means improve re-analyzes a
just-updated asset, which can propose further refinement. That is correct
behaviour (working from current state), is bounded by reflect's
feedback/staleness gating, and is preferable to the after-case's silent loss of
fresh analysis. No mitigation required beyond the existing cooldown guard
(§4.3).

## 14. Investigation: LLM calls instead of an agent profile?

**Conclusion: YES — support `mode: llm | agent | sdk` for the judgment tier,
identical to improve processes, defaulting to `llm`.**

### The plumbing already exists and is mode-agnostic

- `RunnerSpec` is a three-way union: `{kind:"llm", connection}` |
  `{kind:"agent", profile}` | `{kind:"sdk", profile}`
  (`src/integrations/agent/runner.ts:11-14`).
- `resolveImproveProcessRunnerFromProfile(processConfig, config)` already turns
  a `{mode, profile, timeoutMs}` block into any of the three
  (`runner.ts:168-184`).
- `reflect.ts:1060-1090` is the canonical consumer: a `switch (runnerSpec.kind)`
  dispatching `llm → runReflectViaLlm (chatCompletion)`, `sdk → runOpencodeSdk`,
  `agent → runAgent (spawn CLI)`. Triage's judgment tier reuses this verbatim.

### The one real capability difference

`runnerSupportsFileWrite = runnerSpec.kind !== "llm"` (`reflect.ts:971`). The
LLM HTTP path cannot touch the filesystem; agent/SDK paths can. **Triage's
judgment tier returns a verdict (`accept | reject | defer` + reason), not file
writes**, so the LLM path is fully sufficient — the engine performs the actual
`promoteProposal`/`reject` writes itself based on the returned verdict.

### Where each mode fits

- **`llm` (default):** judge a proposal given context the engine pre-fetches and
  injects into the prompt — the proposal diff, the live asset, and sibling
  pending proposals for the same ref. Covers consolidate mid-band accept/reject
  and dedup-against-provided-context. Cheapest, no tool spawning, deterministic
  to test (inject a fake `chatCompletion`).
- **`agent` / `sdk`:** judge with autonomous tool access — the agent can run
  `akm search` across the whole stash to find contradictions, read arbitrary
  assets, and detect duplicates beyond the provided context. This is the only
  case that genuinely needs more than an LLM call (matches the user's "acceptable
  to require an agent profile if it cannot be replicated with LLM calls").

### Plan impact

- §3.2 / §4.1 `judgment` block: `mode` accepts `llm | agent | sdk`; default
  `llm` when omitted. CAVEAT (verified): `resolveImproveProcessRunnerFromProfile`
  itself returns `null` when neither `mode` nor `profile` is set — it does NOT
  fall back to `defaults.llm`. The `defaults.llm` fallback lives in the
  **`resolveValidationRunner` wrapper** (`runner.ts:136-156`), which the triage
  engine must replicate (try the profile resolver, then fall back to
  `defaults.llm`) to actually honor an llm-default.
- §4.1 `drainProposals` gains a `judgment?: RunnerSpec | null` already typed as
  the union — no signature change needed; the dispatch switch is the only new
  code, lifted from `reflect.ts`.
- §8 tests: add an `llm`-mode judgment test (inject fake `chatCompletion`
  returning a verdict) alongside an `agent`-mode test (inject `spawn`), mirroring
  `reflect`'s dual test seams.

## 15. Investigation: run drain right before improve vs. a separate task?

**Conclusion: run it as a PRE-pass folded inside `akm improve` (Approach A).**
The earlier "schedule separately" guidance was overstated — it applied to *tail*
folding, not *pre* folding. Running drain before improve is sound and is the
recommended arrangement.

### Why the original objection does not apply to a pre-pass

The skeptic objection against folding was specifically: a *tail* step inside
improve's `budgetMs` abort scope means a timed-out improve never drains. A
**pre-pass runs first**, before the budget timer is load-bearing for the
reflect loop, so that failure mode disappears.

### Execution fact that rules out the naive chain

`command:` tasks execute a bare argv array via `Bun.spawn(cmd)` with **no shell**
(`src/tasks/runner.ts:168`; `cmd` is `string[]`, verified). So
`command: akm proposal drain && akm improve` does NOT work — there is no shell
to interpret `&&`. To chain in one task you must wrap explicitly:
`command: ["bash","-c","akm proposal drain … ; akm improve …"]`. (Side note,
verified: the spawn `cwd` is `process.env.HOME ?? "/tmp"`, so a chained command
must not assume the repo working directory.)
The clean "one invocation does both" is therefore the folded pre-pass, not a
chained command.

### The three ways to "drain right before improve"

| Approach | Mechanism | Concurrency safety | Timeout | Failure isolation | Cadence |
|---|---|---|---|---|---|
| **A. Pre-pass (folded)** | one `akm improve` does drain→index→loop, gated by `triage.enabled` | **Safe** — under `improve.lock` | shares run budget (give drain its own internal timeout) | try/catch → non-fatal | coupled to improve |
| **B. Chained command** | `["bash","-c","drain ; improve"]` | **Unprotected** — drain not under `improve.lock` | one shared cron `timeoutMs` | use `;`/`\|\| true`, not `&&` | coupled to improve |
| **C. Two ordered tasks** | triage `:00`, improve `:10` | **Unprotected** if a prior improve overruns | independent | independent | independent |

### Genuine risks / limitations of running drain right before improve

1. **No proposals-level lock (the strongest reason to prefer A).**
   `improve.lock` prevents two *improves* overlapping, but nothing guards
   *drain vs. a running improve*. Both mutate `proposals/` — `promoteProposal`
   moves files; improve's auto-accept gate promotes concurrently. Overlap → two
   processes race to promote the same id (one errors) or a file is moved out
   from under the other. **Only Approach A removes this**, by running triage
   inside `improve.lock`. B and C are safe only if no other improve ever
   overlaps the drain window.

2. **Shared timeout budget (A and B).** Deterministic drain is fast; the
   judgment tier (llm/agent) can be slow. Under one process/timeout a slow drain
   steals improve's wall-clock — and the existing `akm-improve` task already
   tunes `--timeout-ms` to ~90% of the 30-min cron ceiling to dodge SIGTERM.
   Mitigation: a dedicated `triage.judgment.timeoutMs`; keep the tier lean; or
   run deterministic-drain inline and the judgment tier as a separate task.

3. **Failure propagation.** A drain crash must not skip improve. Pre-pass:
   try/catch → non-fatal warning. Chained: `;` not `&&`.

4. **Lock-ordering refactor (pre-pass implementation cost).** improve runs
   `ensureIndex`/`collectEligibleRefs` *before* acquiring the lock; the pre-pass
   needs the lock hoisted above them (§7). Modest but real.

5. **Coupled cadence + lifecycle.** Draining happens only when improve runs;
   you cannot later drain every 10 min while improve runs twice daily, and
   disabling improve disables draining. Solvable by *also* adding a standalone
   task later — coupling does not preclude it.

6. **Promote→re-analyze churn.** Triage-before promotes backlog items, so
   improve re-analyzes just-updated assets. It will only *re-propose* if a new
   signal has landed since the last proposal — the 0.8.0 signal-based gate
   (`improve.ts:1662`, "no new signal since last proposal") already stops the
   spin, so no extra cooldown is needed (§4.3).

### Net

Approach A (folded pre-pass) is the recommended default: single `triage.enabled`
toggle, the only option that closes the concurrency hazard, and free index
pickup via improve's existing `ensureIndex`. Ship the `akm proposal drain`
command anyway (§3.1) — it is the engine the pre-pass calls, is independently
testable/runnable, and enables Approach B/C for users who want them.

## 16. How profile configurability de-risks the design (risk → dial)

Making triage a tunable, includable/excludable process turns several of the
§15 risks from hard constraints into adjustable dials. Each dial is ordinary
improve-profile config — no new mechanism.

| Risk (from §15 / safety review) | Dial that controls it | How it helps |
|---|---|---|
| 1. Concurrency with a running improve | run triage as the in-`improve` pre-pass (`processes.triage.enabled` in the run's profile) | under `improve.lock` → serialized; the alternative chained/separate task is the thing that races |
| 2. Slow judgment tier steals improve's wall-clock | `processes.triage.judgment.timeoutMs`; or `judgment.mode: llm` (cheaper) vs `agent`; or omit `judgment` (deterministic-only) | bound or remove the slow tier per profile |
| 2b. Whole run too slow on busy stashes | exclude triage from the heavy profile, enable it in a light `triage-only` profile run on its own schedule | independent cadence without a separate verb |
| 3. Blast radius of a wrong rubric | `applyMode: queue` (default) vs `promote`; `maxAcceptsPerRun`; `maxDiffLines`; `policy` preset | cap volume / stage-only / pick a conservative policy per profile |
| 5. Coupled cadence + lifecycle | a dedicated `triage-only` profile + its own `akm improve --profile triage-only` task | drain on any schedule independent of the main improve cadence |
| Per-environment tuning (personal vs shared stash) | different `policy` + `applyMode` per named profile | a shared-stash profile uses `manual`/`queue`; a personal-stash profile uses `personal-stash`/`promote` |

The single-ref blast-radius concern is handled structurally, not by a dial: the
`scope.mode !== "ref"` guard (decision #1) means `akm improve skill:x` never
drains the queue regardless of profile.

What configurability does **not** soften, and stays enforced in code (§4.3):
the per-run accept ceiling, the diff-line bound on auto-accepts, and the
reject-empty floor. These are guardrails, not preferences — a profile can make
them stricter but not remove them. (Re-accept churn is handled by the existing
signal-based gate, not a triage guardrail — §4.3.)
