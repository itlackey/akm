# Improve End-of-Run Auto-Sync — Investigation & Design

Status: proposed
Author: design synthesis (code-verified)
Target: 0.8.x (additive, opt-in) → no 0.9.0 cleanup needed (no breaking surface)

## Resolved decision & implementation

Status: implemented (0.8.x, branch `feat/git-backed-stash-recognition`).

Chosen model — **batch-at-boundaries with decoupled recognition**:

- **Recognition is by `.git` presence, not by a remote.** `isGitBackedStash(dir)`
  (`src/sources/providers/git.ts`) returns `fs.existsSync(path.join(dir, ".git"))`
  and is the single source of truth (the inline check in `saveGitStash` now calls
  it). `akm init` git-inits the primary stash, so a freshly-initialized local
  stash with no remote is still recognized as git-backed.
- **Recognition is DECOUPLED from the per-write commit path.**
  `resolveWriteTarget` (`src/core/write-source.ts` case-3) deliberately keeps the
  primary stash as `kind: "filesystem"`. Routing per-asset writes through
  `runGitCommit` would be incomplete (stages only the single asset file, leaving
  `.akm/proposals` + other state dirty) and noisy (~25 commits per run).
  Recognition is used only to gate the end-of-run BATCH commit.
- **One COMPLETE batch commit at the end of an improve run** via the existing
  `saveGitStash` (`git add -A`, guarded by the non-akm-dirty check). The seam is
  inside `akmImprove`, under `improve.lock`, immediately before `return result`
  — after all reindex/maintenance. Dry-run returns earlier, so it is inherently
  skipped.
- **Push is gated on `config.writable` + a configured remote** (the existing
  `saveGitStash` push logic). `writableOverride` mirrors `akm sync`
  (`cfg.writable === true ? true : undefined`).
- **Default ON for git-backed stashes.** The built-in `default` and `thorough`
  improve profiles ship `sync: { enabled: true, push: true }`; `quick` /
  `memory-focus` inherit/omit it. Config shape is the top-level improve-profile
  `sync: { enabled?, push?, message? }` block. Disable via
  `profiles.improve.<name>.sync.enabled = false`.
- **CLI flags:** `akm improve --no-sync` disables the end-of-run sync;
  `--no-push` commits but does not push. CLI overrides the profile (only the
  passed keys are threaded, so config defaults win otherwise).
- **Non-fatal:** a sync/push failure is surfaced as a warning and recorded on
  `result.sync` (`{ committed:false, pushed:false, skipped:true, reason }`); it
  never fails a successful run. A `stash_synced` event is emitted either way.

**Deliberate follow-on (NOT in this change):** committing the primary stash
"after other mutating commands" (`accept` / `remember` / `add`) at their own
operation boundaries is a separate future change. This change wires the
end-of-run improve boundary only.

## 1. Goal

Add a **top-level improve-profile option** so that, when `akm improve` finishes,
it can **automatically commit (and optionally push) the primary stash to git** —
the same operation `akm sync` performs manually today. The option is a sibling of
`autoAccept` / `limit` on the improve profile (not a `processes.<proc>` entry),
enable/disable-able like other profile-level settings, with a **separate toggle
to disable pushing** (commit-only vs commit-and-push).

## 2. Verified current state (file:line evidence)

### 2.1 What akm already commits to git during a normal improve run

**The primary stash is NOT auto-committed today.** Two distinct git paths exist;
neither commits the primary stash on a normal run:

1. **`writeAssetToSource` → `runKindSpecificCommit`** (`src/core/write-source.ts:331-356`)
   commits/pushes **only when `source.kind === "git"`** — i.e. an external
   git-*source* with a remote URL. For `kind === "filesystem"` it returns at
   `write-source.ts:337-338` with **no commit step**. The commit granularity is
   **per-asset** (`runGitCommit` stages a single file, `write-source.ts:358-392`;
   `runGitPush` pushes only when `config.options.pushOnCommit`, `:342-343`).
   `promoteProposal` routes accepted payloads through `writeAssetToSource`
   (`src/core/proposals.ts:1023`), so promotion only git-commits when the asset's
   resolved *source* is a `git` kind.

2. **`saveGitStash`** (`src/sources/providers/git.ts:474-584`) is the **stash-level**
   commit/push utility, invoked **only** by the manual `akm sync` / `akm save`
   commands via `runSyncBody` (`src/cli.ts:1320`). Nothing in the improve pipeline
   calls it.

**Consequence (verified against the user's environment):** the primary stash
`stashDir` (`/home/founder3/akm`, from `~/.config/akm/config.json`) is a
**`kind: filesystem`** stash — it is a git repo *on disk* but akm writes to it as
a filesystem source (the separate `itlackey/akm-stash` git source is a different
remote-backed source). Therefore `promoteProposal`/`writeAssetToSource` take the
filesystem branch and **never commit it**. Live inspection confirms the stash is
left **dirty** after runs:

```
$ git -C /home/founder3/akm status     # ~14 modified/deleted files, uncommitted
$ git -C /home/founder3/akm remote -v  # (empty — NO remote configured)
$ git -C /home/founder3/akm log -5     # commits are "akm save <ts>" / "improve runs"
```

The "akm save" commits in history are from the user manually running `akm sync`/
`akm save`, **not** from improve. This is precisely the gap the feature closes.

### 2.2 `saveGitStash` already implements the entire desired behaviour

`saveGitStash(name?, message?, writableOverride?, { push? })`
(`src/sources/providers/git.ts:474-584`) already does, in order:

- not-a-git-repo → `{ skipped: true, reason: "not a git repository" }` (`:514-516`)
- clean tree → `{ committed: false, output: "nothing to commit…" }` (`:525-527`)
- **non-akm dirty-path guard (#476):** refuses if any dirty path is outside the
  akm-managed subtrees (`TYPE_DIRS` + `.akm/`), preventing a shared-repo `git add -A`
  from sweeping unrelated user WIP (`:529-545`). Only after this guard passes does
  it `git add -A` (`:549-550`).
- commit with a fallback identity (`-c user.name=akm -c user.email=akm@local`,
  `:554-564`)
- **push gating:** push only when `hasRemote && writable && allowPush`
  (`:570-583`); otherwise returns `{ committed: true, pushed: false }`.
- `allowPush = options.push !== false` (`:482`) — this is the existing `--no-push`
  seam.

Return shape `SaveGitStashResult = { committed, pushed, skipped, reason?, output }`
(`src/sources/providers/git.ts:454-460`).

This means **the feature is mostly wiring**, not new git logic. We call the exact
function `akm sync` calls, with config-derived arguments.

### 2.3 Where an improve run finishes (the integration seam)

`akmImprove` (`src/commands/improve.ts:754`) structure:

- The `improve.lock` is acquired above the pre-index/triage region
  (`improve.ts:787-840`) and released in the **outer `finally`**
  (`improve.ts:1246-1261`, `fs.unlinkSync(resolvedLockPath)` at `:1251`).
- **Dry-run returns early** at `improve.ts:1001-1014` (`dryRun: true`), *before*
  the main success `try` block — so any sync placed in the success path is
  inherently dry-run-safe.
- The success path assembles `result` (`improve.ts:1148-1218`), emits
  `improve_completed` (`:1219-1230` via `emitImproveCompletedEvent`, `:1264-1322`),
  then `return result` (`improve.ts:1231`). All tree mutations — triage pre-pass,
  reflect/distill/consolidate, memoryInference/graphExtraction, post-loop
  maintenance, and the post-cleanup **reindex** (`runImprovePostLoopStage`,
  reindex at `improve.ts:1566`) — have completed by this point.

The CLI wrapper `improve-cli.ts` then records the run and `process.exit(0)`
(`src/commands/improve-cli.ts:170-247`). Its SIGTERM/SIGINT/SIGHUP handlers
(`:152-168`) persist a *terminated* record and exit; a terminated run must **not**
sync (partial state).

**Recommended seam: inside `akmImprove`, in the success path, immediately before
`return result` (`improve.ts:1231`), still INSIDE the lock-protecting `try`
(so the `finally` at `:1246` still releases the lock).** Rationale:

- Sync runs **after** all mutations and the reindex — single final commit.
- Still **under `improve.lock`**, so no second improve run can mutate the tree
  mid-commit. `saveGitStash` is a fast local `git add`/`commit` (+ optional push);
  holding the lock a few hundred ms longer is acceptable and strictly safer than
  releasing first.
- Dry-run already returned at `:1014`, so no extra guard needed beyond a defensive
  `if (!result.dryRun)`.
- Doing it inside `akmImprove` (not `improve-cli.ts`) means the **programmatic API
  and any future callers** get sync too, and the result object can carry the sync
  outcome for the recorded run row.

Reject placing it in `improve-cli.ts` after `writeImproveResultFile`: that runs
*outside* the lock and would not benefit non-CLI callers; and the
`process.exit(0)` at `:247` would need a try/await wrapper. The only thing
`improve-cli.ts` should do is surface the sync result that `akmImprove` already
computed.

## 3. Recommended config shape

Top-level on the improve profile (sibling of `autoAccept`/`limit`), **not** a
process. It is not per-ref and not a pipeline stage; it is a post-run side-effect
of the whole run — structurally like `autoAccept`/`limit`.

### 3.1 Type (`src/core/config-types.ts`, in `ImproveProfileConfig` ~`:215`)

```ts
export interface ImproveSyncConfig {
  /** Master enable. Default: false (off, matching validation/triage safety posture). */
  enabled?: boolean;
  /** When true (default), push after commit IF the stash is writable AND has a remote.
   *  Set false for commit-only. Mirrors `akm sync --no-push`. */
  push?: boolean;
  /** Optional commit message; defaults to the timestamped `akm save <ts>` form. */
  message?: string;
}

export interface ImproveProfileConfig {
  description?: string;
  processes?: { /* …unchanged… */ };
  autoAccept?: number;
  limit?: number;
  sync?: ImproveSyncConfig;   // ← new
}
```

`remote`/`branch` are **deliberately omitted** (rejected — see §8): `saveGitStash`
uses the repo's configured upstream (`git push` with no args). Adding remote/branch
selection here would duplicate git config and create a second source of truth.

### 3.2 Schema (`src/core/config-schema.ts`, `ImproveProfileConfigSchema` `:216-223`)

`ImproveProfileConfigSchema` is `.strict()` (`:223`), so the field **must** be
added or valid configs are rejected:

```ts
const ImproveSyncConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    push: z.boolean().optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

export const ImproveProfileConfigSchema = z
  .object({
    description: z.string().min(1).optional(),
    processes: ImproveProfileProcessesSchema.optional(),
    autoAccept: nonNegativeNumber.optional(),
    limit: positiveInt.optional(),
    sync: ImproveSyncConfigSchema.optional(),   // ← new
  })
  .strict();
```

### 3.3 Resolution

`resolveImproveProfile` → `deepMerge(builtin, userOverride)`
(`src/commands/improve-profiles.ts:133-154`). `deepMerge` (`:112-131`) already
recurses into nested objects and treats `null` as `undefined`, so a user override
like `{ sync: { push: false } }` merges field-wise over a built-in `{ sync: {
enabled: true, push: true } }`. No `deepMerge` change needed.

**Built-in defaults: OFF.** All four `BUILTIN_PROFILES` (`improve-profiles.ts:21-70`)
either omit `sync` or set `sync: { enabled: false }`. This matches the opt-in
safety posture of `validation` (`IMPROVE_PROCESS_DEFAULTS.validation = false`,
`:86`) and `triage` (`:93`). A run only syncs when the user explicitly opts in via
`profiles.improve.<name>.sync.enabled = true` (or `--sync`, below). Add a helper
mirroring `resolveProcessEnabled`:

```ts
export function resolveSyncEnabled(profile: ImproveProfileConfig): boolean {
  return profile.sync?.enabled === true;   // default false
}
export function resolveSyncPush(profile: ImproveProfileConfig): boolean {
  return profile.sync?.push !== false;     // default true
}
```

### 3.4 CLI flags

Add to `improveCommand.args` (`src/commands/improve-cli.ts:30-75`):

- `--sync` / `--no-sync` (boolean, default unset) — override `sync.enabled` for
  this run.
- `--no-push` (boolean) — override `sync.push` for this run (only meaningful when
  syncing).

These thread into `AkmImproveOptions` as `sync?: { enabled?: boolean; push?: boolean }`
and override the resolved profile value (CLI > profile > built-in). Pattern matches
how `--auto-accept`/`--limit` already override profile values.

## 4. Integration seam (concrete)

In `akmImprove`, just before `return result;` (`improve.ts:1231`):

```ts
if (!result.dryRun && primaryStashDir && resolveSyncEnabled(improveProfile)) {
  try {
    const cfg = loadConfig();
    const writable = cfg.writable === true ? true : undefined;     // matches runSyncBody (cli.ts:1317)
    const push = resolveSyncPush(improveProfile);
    const syncResult = saveGitStash(undefined, improveProfile.sync?.message, writable, { push });
    appendEvent({
      eventType: "stash_synced",
      metadata: {
        committed: syncResult.committed,
        pushed: syncResult.pushed,
        skipped: syncResult.skipped,
        reason: syncResult.reason ?? null,
        trigger: "improve",
      },
    }, eventsCtx);
    (result as AkmImproveResult).sync = {
      committed: syncResult.committed,
      pushed: syncResult.pushed,
      skipped: syncResult.skipped,
      ...(syncResult.reason ? { reason: syncResult.reason } : {}),
    };
  } catch (err) {
    // Non-fatal — see §5. Surface as a warning, never fail a successful run.
    warn(`[improve] end-of-run sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    (result as AkmImproveResult).sync = { committed: false, pushed: false, skipped: false,
      error: err instanceof Error ? err.message : String(err) };
  }
}
```

`saveGitStash` is synchronous (`spawnSync`), so this adds no async hazard inside
the lock. Use `undefined` for `name` to target the **primary stash** (the
`resolveStashDir` branch, `git.ts:505-511`), which is what improve mutates.

## 5. Failure & safety model

Mirror the **non-fatal warning** posture already used for contradiction-detection
and the triage pre-pass (`improve.ts:909-910` triage failure is "non-fatal,
never an abort"). A sync/push failure must **not** fail a run whose actual work
(reflect/distill/consolidate) already succeeded and is recorded.

`saveGitStash` already handles the dangerous cases:

- **No remote** (the user's actual case): `hasRemote === false` → commit only, no
  push attempt (`git.ts:570-577`). Graceful by construction.
- **Not writable** (`config.writable` unset, the user's case): push skipped
  (`:576`). Commit-only is the default outcome for this stash.
- **Unrelated dirty files in a shared repo:** the `collectNonAkmDirtyPaths` guard
  throws *before* any `git add -A` (`:529-545`); our `try/catch` turns that throw
  into a warning. **Scope decision: keep `git add -A` (not a scoped add).** For a
  stash repo akm owns, `add -A` is correct because the guard already proved every
  dirty path is akm-managed; a narrowly-scoped add would miss deletions/renames the
  improve cleanup performs. This respects the global "never blind `git add -A`/push"
  rule because the add is gated behind the non-akm guard and push is gated behind
  `writable && hasRemote`.
- **Push fails (auth / non-fast-forward / detached HEAD):** `saveGitStash` throws
  (`:580-583`); caught → warning. The commit still landed locally, so no data loss.

**Pull-before-push: NO.** Out of scope for v1. `saveGitStash` does a plain
`git push`; a non-fast-forward simply warns. Auto-pull/merge/rebase in an
unattended improve run risks conflicts and is a larger design. Document that
push targets a fast-forwardable upstream; users with divergent remotes should run
`akm sync` manually or keep `push: false`.

## 6. Observability

- **Event:** emit `stash_synced { committed, pushed, skipped, reason?, trigger:
  "improve" }` (new event type — add to the union in `src/core/events.ts` near the
  existing `"save"` at `events.ts:51`). Reusing `"save"` is possible but a distinct
  type lets `akm health` separate operator-driven syncs from improve-driven ones.
- **Improve result:** add `sync?: { committed; pushed; skipped; reason?; error? }`
  to `AkmImproveResult` so `writeImproveResultFile` (`improve-cli.ts:231`) persists
  it into the `improve_runs` row. `improve-cli.ts` can optionally log one stderr
  line (`[improve] stash synced: committed=… pushed=…`) consistent with existing
  progress logging.
- **`akm health`:** a follow-up can surface a `stashSync` summary (last sync,
  committed/pushed counts, last failure) from the `stash_synced` events, analogous
  to the existing improve summaries. Not required for v1.

## 7. Interaction with the just-merged triage feature

Triage runs as the improve **pre-pass** (`improve.ts:885-911`), promoting proposals
via `drainProposals` → `promoteProposal`. Whether those promotions git-commit
depends on the asset's source kind (§2.1): for the **filesystem primary stash they
do NOT commit** — they only write files, leaving the tree dirty. The reflect/
distill/consolidate loop and post-loop maintenance likewise only write files for a
filesystem stash.

Therefore an end-of-run sync **batches all of it into one final commit**, which is
the desirable outcome. There is **no double-commit risk** for the common
(filesystem) stash because nothing else commits it. (For a `kind: git` stash with a
remote, per-asset commits already happen via `runKindSpecificCommit`; an end-of-run
`saveGitStash` would then find a clean-or-near-clean tree and either no-op or commit
only the residual `.akm/` state — still safe, just possibly a small extra commit.
Acceptable; can be refined later by skipping sync when the stash's own source is
`kind: git`.)

**Lock:** sync runs inside the same `improve.lock` (released at `improve.ts:1251`),
after triage and all mutations, so there is **no lock conflict** and no interleaving
with a concurrent improve. Ordering is guaranteed: triage → loop → post-loop →
reindex (`:1566`) → **sync** → `return`.

## 8. Rejected alternatives

1. **`processes.sync` (a pipeline process):** rejected. Sync is not per-ref and not
   a candidate-set pass; it is a whole-run side-effect. `autoAccept`/`limit` are the
   right precedent — top-level profile fields. (The task framing is correct.)
2. **`remote`/`branch` in the config:** rejected for v1. Duplicates git's own
   upstream config; `git push` with no args already does the right thing.
   Re-introduce only if a real multi-remote use case appears.
3. **Sync in `improve-cli.ts` after the result file write:** rejected. Outside the
   lock; excludes programmatic callers; collides with `process.exit(0)`.
4. **Releasing the lock before sync:** rejected. A concurrent improve could mutate
   the tree between release and commit. The commit is local and fast; hold the lock.
5. **Auto pull/rebase before push:** rejected for v1 (conflict risk in unattended
   runs). Warn on non-fast-forward instead.
6. **Scoped `git add <paths>` instead of `add -A`:** rejected. Would miss
   deletions/renames; the existing non-akm-dirty guard already makes `add -A` safe
   for an akm-owned stash.
7. **Default ON:** rejected. Matches `validation`/`triage` opt-in safety posture;
   committing/pushing on the user's behalf must be an explicit choice.

## 9. Phased implementation outline

1. **Schema + types:** add `ImproveSyncConfig` to `config-types.ts` and
   `ImproveSyncConfigSchema` to the `.strict()` `ImproveProfileConfigSchema`
   (`config-schema.ts:216`).
2. **Resolvers:** add `resolveSyncEnabled`/`resolveSyncPush` to
   `improve-profiles.ts`; leave built-in profiles defaulting OFF.
3. **Result type + event:** add `sync?` to `AkmImproveResult`; add `stash_synced`
   to the `events.ts` event-type union.
4. **Seam:** insert the §4 block before `return result` (`improve.ts:1231`),
   wrapped in `if (!result.dryRun && resolveSyncEnabled(...))` and `try/catch`
   (non-fatal). Thread an optional `options.sync` override into `AkmImproveOptions`.
5. **CLI:** add `--sync`/`--no-sync`/`--no-push` to `improveCommand`
   (`improve-cli.ts:30`); map to `options.sync`; surface `improveResult.sync` in
   the recorded run / optional stderr line.
6. **Tests:** filesystem stash with dirty tree → committed, not pushed; clean tree
   → skipped(no-op); no-remote → commit-only; non-akm dirty → warning, run still
   `ok:true`; dry-run → no sync; `--no-sync` overrides an enabled profile;
   `sync.push:false` → commit-only even with remote+writable.
7. **Docs:** README/improve-workflow note + config reference.

## 10. Open decisions for the maintainer

1. **Should sync be skipped when the primary stash's own source is `kind: git`**
   (to avoid the extra residual commit on top of per-asset commits)? Recommend:
   yes, skip — but low priority; safe either way.
2. **`stash_synced` vs reuse `save` event type** — recommend new type for
   health separability. Confirm.
3. **Default `push` value** when `sync.enabled` is true: recommend `true`
   (commit-and-push when writable+remote), since the no-remote/non-writable cases
   already degrade to commit-only safely. Confirm vs a more conservative
   commit-only default.
4. **CLI flag naming:** `--sync`/`--no-sync` + `--no-push`, or a single
   `--sync=commit|push|off`? Recommend the two-boolean form for consistency with
   `akm sync --no-push`.
5. **Health surfacing** of sync stats — in scope for this change or a follow-up?
   Recommend follow-up.
