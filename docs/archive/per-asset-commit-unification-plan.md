# Per-Asset Commit → Batch-at-Boundary Unification (0.9.0)

Status: ✅ Shipped in 0.9.0 (#507 — per-asset commit path retired; see src/core/write-source.ts).
Origin: `docs/technical/improve-autosync-investigation.md` §"Per-asset commit: can/should we remove it?"

## Problem

There are two commit models for git-backed stashes today:

1. **Batch** — the primary stash commits via `saveGitStash` (`git add -A`, guarded)
   at operation boundaries (the 0.8.x improve end-of-run auto-sync). Complete and
   clean: one commit per operation.
2. **Per-asset** — writes to a *named writable git source* (via `--target` /
   `defaultWriteTarget`) commit one file at a time through
   `runKindSpecificCommit` → `runGitCommit` (+ `runGitPush` when
   `config.options.pushOnCommit`) in `src/core/write-source.ts`.

The per-asset path is incomplete relative to batch (it stages only the single
asset file, leaving `.akm/` and sibling state dirty), is noisy at scale, and its
`pushOnCommit` knob is effectively undocumented (only in the v1 spec pseudocode
and `architecture.md`; no CLI flag, no config example). User-facing docs already
present `akm save`/`akm sync` (batch) as the persistence story for writable git
sources.

The two coexist cleanly today only because their domains are disjoint (batch =
primary stash; per-asset = named `--target` git sources). The goal is to unify on
the batch model.

## Why this was NOT done in 0.8.x

- Removing per-asset commit silently regresses `akm add --target <writable-git>`
  (write lands uncommitted, no signal).
- Breaks committed contract tests: `tests/core/write-source.test.ts:206/220/238/256`
  + the #270 sanitization suite.
- Contradicts the locked v1 spec (`v1-architecture-spec.md:176-186`), which
  mandates the `kind==="git"` commit as the single intentional kind-branch point.
  Removing it is a spec amendment, not a refactor.

## Target design (0.9.0)

Replace the per-asset commit with a **batch-at-command-boundary** commit for
named git targets, reusing the existing `saveGitStash(name)` (`git.ts:507-517`,
which already commits a named git source by resolving its repoDir). Because the
mutating commands write one asset per invocation, "batch" is a single, complete
commit in practice — same net behavior, one code path.

### Work items

1. **Write path** — in `src/core/write-source.ts`, drop the `runGitCommit` /
   `runGitPush` arm from `runKindSpecificCommit`; the per-write step becomes a
   plain filesystem write for all kinds (the `kind` branch collapses). Keep the
   path-escape / writability guards.
2. **Command boundaries** — after a mutating command finishes writing to a
   resolved git `--target`/`defaultWriteTarget`, call `saveGitStash(targetName,
   message, writable, { push })` once. Thread the resolved target name to the
   boundary. Callers: `add-cli`, proposal `accept`/`revert`, `knowledge`,
   `consolidate`. (`memory-inference` is hardcoded filesystem — unaffected.)
3. **Config** — retire/deprecate `SourceConfigEntry.options.pushOnCommit`
   (`config-schema.ts:255`, `config-types.ts:286`). Map its intent onto the
   batch push gate (`writable` + remote + a push toggle), consistent with the
   improve `sync.push` flag.
4. **Tests** — re-home `tests/core/write-source.test.ts` git assertions to the
   new boundary-commit behavior; keep the commit-message sanitization coverage
   (move it to wherever the message is now built).
5. **Spec** — amend `v1-architecture-spec.md:176-186`: the single kind-branch
   point is removed; persistence for git sources is the batch `saveGitStash`
   path. Note this in the 0.9.0 migration notes.
6. **Docs** — update `concepts.md`, `cli.md`, `features/sources-registries.md`,
   `architecture.md` references to per-asset commit / `pushOnCommit`.

### Migration / compat

- 0.9.0 is the agreed window to remove 0.8 shims (see the clean-break release
  model). Removing `pushOnCommit` fits that window; emit a deprecation warning if
  it is encountered in config during a 0.8.x → 0.9.0 transition, mapping it to the
  batch push toggle.

## Acceptance

- A write to a writable git `--target` results in exactly one complete commit
  (and a push when writable + remote + push-enabled), with no dirty residue.
- `runKindSpecificCommit`'s kind-branch is gone; `write-source.ts` no longer
  branches on `kind` for commit behavior.
- v1 spec + docs reflect the single (batch) model; `pushOnCommit` deprecated.
- No silent uncommitted writes on any documented path.
