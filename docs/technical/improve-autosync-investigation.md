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

---

## Per-asset commit: can/should we remove it?

> Question: can/should we delete the per-asset commit path
> (`runGitCommit`/`runGitPush` inside `runKindSpecificCommit`,
> `src/core/write-source.ts:340-408`) before merging, replacing it with
> batch commits at command boundaries?

### (a) What fires it, and who depends on it (evidence)

**What fires it.** `runKindSpecificCommit` (`src/core/write-source.ts:340`)
branches on `source.kind`:

- `kind: "filesystem"` → returns immediately, NO commit (`:346-348`).
- `kind: "git"` → `runGitCommit(source.path, filePath, message)` (`:350`),
  then `runGitPush(source.path)` ONLY when `config.options?.pushOnCommit` is
  truthy (`:351-353`).
- any other kind → `ConfigError` (`:359-364`).

`runGitCommit` (`:367-401`) stages the **single asset file** (`git add -- <rel>`,
`:371`) and commits it (`Update <ref>` / `Remove <ref>`); `nothing to commit`
is treated as a no-op success. `runGitPush` (`:403-408`) is a plain `git push`.

So the exact combination that reaches a commit is **(kind === "git", writable,
reached via `writeAssetToSource`/`deleteAssetFromSource`)**, and push
additionally requires **`options.pushOnCommit === true`**.

**A git target is only produced by `adaptConfiguredSource`** (`:435-470`), which
is reached from `resolveWriteTarget` ONLY in the `--target` branch (`:252`) and
the `defaultWriteTarget` branch (`:272`). The third branch — the primary working
stash (`:292-300`) — hardcodes `kind: "filesystem"`, with an explicit comment
(`:286-291`) that routing the stash through per-asset `runGitCommit` would be
"INCOMPLETE … and NOISY (one commit per asset, ~25 per improve run)". **The
primary stash therefore never reaches `runGitCommit`.** Confirmed.

**Callers that could resolve a git target:**

| Caller | Call site | Target source | Can be `kind:"git"`? |
|---|---|---|---|
| `promoteProposal` | `proposals.ts:992,1023` | `resolveWriteTarget(config, options.target)` | YES — via `--target` or `defaultWriteTarget` |
| `revertProposal` | `proposals.ts:1111-1112` | `resolveWriteTarget(config, options.target)` | YES |
| `resolvePromotionTarget` | `proposals.ts:1166` | `resolveWriteTarget(config, options.target)` | YES |
| `knowledge` (add) | `knowledge.ts:136,157` | `resolveWriteTarget(cfg, options.target)` | YES |
| `consolidate` | `consolidate.ts:1399,1578,1594,1647` | `resolveWriteTarget(config)` (no explicit target) | YES, only via `defaultWriteTarget` |
| `memory-inference` | `memory-inference.ts:398-420` | hardcoded `kind:"filesystem"`, `stashRoot` | NO — primary stash only |

So per-asset commit is **live** for any add/promote/revert/consolidate write
whose target resolves to a writable git source. It is the de-facto write path
for the "author directly into a cloned writable git stash" workflow.

**Who actually relies on writable git-type sources.** The writable-git-clone
feature is real and supported:

- `install-types.ts:26` — "Treat the cloned repo as writable (keeps `.git` and
  pulls instead of re-cloning)."
- `docs/cli.md:666` — `--writable` flag: "Mark a git source as writable so
  `akm sync` also pushes (default: false)."
- `docs/features/sources-registries.md:117` — `akm save my-skills -m "Update"
  # Named writable git source`.
- `docs/cli.md:846` — `akm sync my-skills  # Sync a named writable git stash`.

BUT note what the **user-facing docs say persists those writes**: every one of
them describes `akm save`/`akm sync` (→ `saveGitStash`, a BATCH `git add -A`
commit, `git.ts:487-604`) as the persistence mechanism — NOT per-asset commit.

**`pushOnCommit` is effectively undocumented.** Outside the v1 spec pseudocode
(`v1-architecture-spec.md:179,202,411`) the only mention in the docs tree is
`docs/technical/architecture.md:168` ("…and `git push` when `options.pushOnCommit`
is set"). It appears in **no** user-facing CLI/feature doc, no `akm config`
example, and there is no CLI flag that sets it. It is an internal config knob.

### (b) CAN we remove it? — YES (technically)

Removing the `kind === "git"` arm of `runKindSpecificCommit` does **not** touch
the primary-stash work at all: the primary stash is `kind:"filesystem"`, takes
the early-return arm, and is committed by the separate `saveGitStash` batch path
(end-of-improve auto-sync + `akm sync`). Nothing in the new git-backed-stash
recognition work depends on `runGitCommit`. The branch can be deleted, leaving
`runKindSpecificCommit` as filesystem-noop + reject-unknown-kind — or removed
entirely so `writeAssetToSource` becomes a pure filesystem write.

### (c) SHOULD we remove it before merging? — NO. Regression + contract analysis

Removing it now is a **behavioral regression for writable git sources** and
**breaks committed contract tests**:

**Contract tests that assert per-asset commit/push** (`tests/core/write-source.test.ts`):

- `:206` "performs a git commit after writing" — asserts clean tree post-commit.
- `:220` "pushes when pushOnCommit option is set" — asserts the commit lands on
  the bare remote (`Update memory:pushed`, `:235`).
- `:238` "does not push when pushOnCommit is absent".
- `:256` "removes the asset and commits the removal on git sources".
- `:271` "filesystem delete is a plain unlink (no commit)" (stays valid).
- `:448-` commit-message sanitization suite (issue #270) drives the git arm
  end-to-end (`:451,473`) — these would need re-homing onto `saveGitStash`,
  which has its OWN sanitization tests already (`git.test.ts:277-398`), so
  coverage isn't lost, but the write-source tests would be deleted.

The v1 architecture spec **mandates** the per-asset commit as the canonical
shape: `v1-architecture-spec.md:176-186` shows the `if (source.kind === "git")`
commit/push inside `writeAssetToSource` and calls it "the **only** place in the
codebase that branches on `source.kind`, and it's intentional". `architecture.md:167-168`
restates it. Removing it now contradicts the locked v1 spec text; that's a
spec amendment, not a refactor, and is out of scope for a stash-recognition
branch.

**Functional regression:** today an `akm add --target <writable-git-source>` (or
with `defaultWriteTarget` set to one) persists immediately. If we delete the git
arm with no replacement, that write lands on disk **uncommitted** — the user
must now know to run `akm sync <name>` to persist, with zero in-tool signal.
That's a silent data-durability regression for a supported, documented
workflow.

### (d) If we removed it: the exact replacement + migration

Were this pursued as a deliberate unification (a separate, spec-amending PR, not
this branch), the clean replacement is **batch-at-command-boundary using the
existing `saveGitStash(name)`**, which already commits a NAMED git source by
resolving its `repoDir` (`git.ts:507-517`) and handles remote/writable/push
gating identically. Required work:

1. Delete the `kind === "git"` arm in `runKindSpecificCommit`
   (`write-source.ts:349-355`); keep the filesystem no-op + unknown-kind reject.
2. At each command boundary that can write to a non-stash git `--target`
   (`add`/promote/revert in `proposals.ts`, `knowledge.ts`, `consolidate.ts`),
   after all writes call `saveGitStash(targetName, message, writable, { push })`
   ONCE. Because these commands write **one asset at a time**, "batch" is a
   single-file commit in practice — functionally equivalent to today's per-asset
   commit but routed through the single batch primitive. The win is one commit
   path, not two.
3. Thread the resolved target **name** out of `resolveWriteTarget` to the
   command boundary (today callers only keep `source`/`config`; the name is on
   `source.name`, so this is available).
4. Replace `pushOnCommit` semantics: `saveGitStash` pushes on
   (remote && writable && allowPush), so the `pushOnCommit` config knob becomes
   redundant. Either map `pushOnCommit` → the `writable` push gate or drop it
   (it's undocumented, so dropping is low-risk but is a config-schema change:
   `config-types.ts:286`, `config-schema.ts:255`).
5. Tests/docs to update: delete/rewrite the `tests/core/write-source.test.ts`
   git-commit/push/sanitization cases onto the boundary path; amend
   `v1-architecture-spec.md:160-209` and `architecture.md:167-168` to describe
   the batch model; the user-facing docs already describe `akm save`/`sync` as
   the persistence path so they need no change.

This is non-trivial (config-schema change + spec amendment + test re-homing) and
delivers no behavior change for users — purely an internal consolidation.

### Recommendation

**KEEP-BUT-UNIFY-LATER.** It does **not** block merging the current branch. The
primary-stash git-recognition + batch-sync work is fully decoupled from
`runGitCommit` (primary stash is `kind:"filesystem"` and never reaches it).
Removing the per-asset path now would (1) silently break durability for the
supported writable-git `--target` workflow unless a boundary `saveGitStash` is
wired in, (2) break committed v1-spec contract tests, and (3) contradict the
locked v1 spec — all out of scope for a stash-recognition branch. Land this
branch as-is; open a follow-up to unify both write paths onto `saveGitStash`
(batch) as a deliberate spec amendment, where the `pushOnCommit` knob and the
two parallel commit implementations can be retired together. Until then the two
models coexist cleanly because their domains are disjoint: **batch for the
primary stash, per-asset for named/`--target` writable git sources.**

## Commit message templates (`sync.message`)

`profiles.improve.<name>.sync.message` accepts `{token}` placeholders, expanded
at the end of the run by `renderSyncCommitMessage` (src/commands/improve.ts)
before the string is handed to `saveGitStash` (which still sanitizes it to a
single line). Unknown tokens pass through verbatim, so templates are
forward-compatible and a literal brace is harmless.

Supported tokens. The "free" set is derived from data already on the run
result; the remaining tokens required extra plumbing (capturing the triage
pre-pass `DrainResult` and threading the CLI-minted `runId` onto the result):

| token | value | source |
|-------|-------|--------|
| `{timestamp}` | `YYYY-MM-DD HH:MM:SS` (UTC) | free |
| `{date}` | `YYYY-MM-DD` (UTC) | free |
| `{time}` | `HH:MM:SS` (UTC) | free |
| `{scope}` | scope value (a ref/type) or the scope mode (`all`) | free |
| `{refs}` | number of planned refs processed this run | free |
| `{accepted}` | proposals auto-accepted by the confidence gate | free |
| `{triage_promoted}` | proposals promoted by the triage pre-pass (`0` if triage did not run) | extra plumbing (`result.triage`) |
| `{triage_rejected}` | proposals rejected by the triage pre-pass (`0` if triage did not run) | extra plumbing (`result.triage`) |
| `{runId}` | this run's id (empty string when absent) | extra plumbing (`result.runId`) |

Example:

```yaml
profiles:
  improve:
    default:
      sync:
        enabled: true
        push: true
        message: "akm improve: {accepted} accepted, {refs} refs @ {timestamp}"
```

The default message (`akm improve auto-sync`) has no tokens and renders verbatim.

Tokens that need extra plumbing — `{triage_promoted}` / `{triage_rejected}`
(triage `DrainResult` is not yet surfaced on `AkmImproveResult`) and `{runId}`
(minted in improve-cli.ts, not threaded into `akmImprove`) — are tracked as a
0.9.0 follow-on.
