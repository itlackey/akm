# akm Core Principles

How akm is built. These are the rules the code, the tests and the
documentation in this repository follow. What akm does for a user is
described in [Architecture](architecture.md), whose "Invariants" section
lists the behaviors every command keeps.

Each principle states the rule, why it exists, and what enforces it. A rule
with nothing enforcing it is held by review, and says so.

## Precedence

When two principles pull against each other: a user's data comes first,
then honesty (code and documentation that do what they say), then
simplicity, then convenience.

## Principles

### 1. Delete before you add

The default answer to a new guard, cap, version gate, option, mode or layer
is no. A guard survives only if it has demonstrably helped a real user, its
failure mode costs less than the hazard it prevents, and the operation is
not already behind a deliberate human command. "This hazard is
conceivable" is not a reason. When something must change, remove the limit
first, degrade with a warning second, abort last. Machinery that prevents
data loss or corruption, such as backups, atomic writes, write-path
validation and path containment, is exempt.

Why: every footgun this codebase has removed was a guard added because a
hazard was conceivable; the limits made the tool refuse to do its job
more often than they protected anyone.

Enforced by: review. The worked examples in `AGENTS.md` are the precedent.

### 2. One place per policy

A rule lives in exactly one module and everything else calls it. Write
destinations branch on source kind only in `src/core/write-source.ts`.
Fan-out widths are decided once in `src/workflows/concurrency-policy.ts`.
Child-process environment allowlists come from `src/core/spawn-env.ts`.
Every agent harness registers once in `HARNESS_REGISTRY`
(`src/integrations/harnesses/index.ts`) and core imports the registry, not
a harness. Runtime-specific APIs (`bun:sqlite`, `Bun.*`) are reached only
through `src/storage/database.ts` and `src/runtime.ts`.

Why: a policy copied into three places drifts into three policies, and
the drift is invisible until a user hits the one that differs.

Enforced by: the construction-time drift guard on `HARNESS_REGISTRY` and
`tests/harnesses-registry.test.ts`; `scripts/lint-secret-resolver-boundary.ts`
for secret reads; `tests/contracts/module-boundaries.test.ts` for the
module table. The write chokepoint and the no-direct-harness-imports rule
are held by review; the opencode-sdk path still bypasses the second one in
the config schema, setup, health, the engine fallback and workflow
teardown, which is open work.

### 3. One current shape per format, migrated forward in one place

Each stored format has exactly one shape in code: the current one. Readers
never carry compatibility shims for old shapes. akm's own stores
(`state.db`, `index.db`, the lock and cache files) are migrated to the
current shape automatically when opened, in the migrations module, with a
backup written before any destructive step. Files the user owns, such as
task sources inside a bundle, are never rewritten without being asked: the
command stops and names `akm migrate apply`, which rewrites them with a
backup. Data written by a newer release is refused, and the error says to
upgrade.

Why: tolerant readers scatter one format into many, and shims for shapes
nobody can delete accumulate in the hot path. A single migration path is
tested once, runs once, and leaves one shape behind.

Enforced by: `tests/integration/upgrade-rehearsal/`, which installs the
previous release, builds real state and runs the current build against it.
[Persisted-Data Compatibility](persisted-data-compat.md) lists each stored
format; a change to one adds its old shape to the rehearsal.

### 4. Sane defaults, flexible overrides

Every default works out of the box for the common case, which for anything
touching a model means a slow local model on a single-threaded server: no
`max_tokens` sent unless asked, one timeout, concurrency one against a
loopback endpoint. Every default is overridable where it applies, per
engine under `engines.<name>.*`, per workflow step, per command flag, and
the override is honored as given. The tool never second-guesses a value
the user set; the one place it still does, clamping a workflow fan-out width
above 64, is debt rather than policy.

Why: defaults that need tuning before the first useful result lose the
user; overrides that are ignored or capped behind the user's back lose
their trust.

Enforced by: `tests/concurrency-defaults.test.ts` and
`tests/engine-resolution.test.ts`; the rest is review.

### 5. If it matters, a test or lint checks it

Any rule we want to hold is pinned: output shapes and exit codes, the ref
grammar, the module table, the engine boundary, that every command and
flag named in a doc exists, that shipped assets carry no dead refs. The pin
is a test under `tests/contracts/`, a unit test, or a script in the `lint`
chain. A rule nobody pinned is a preference, and may change without
ceremony.

Why: the documentation drifted from the code for months because the pages
said "normative" and nothing checked.

Enforced by: `bun run lint` (`scripts/lint-doc-examples.ts`,
`scripts/lint-shipped-assets.ts`, `scripts/lint-secret-resolver-boundary.ts`),
`tests/contracts/`, `tests/output-shapes-unit.test.ts`.

### 6. The suite is green by default and isolated by construction

`test:unit` and `test:integration` report zero failures at all times. A
red run is a real break, never noise to route around; a test that must be
disabled is disabled explicitly with a linked issue. A test that opens a
real database, touches the network, or spawns a process lives under
`tests/integration/`; everything else lives under `tests/`. Tests never
touch the developer's home: the preload sandboxes `HOME` and `XDG_*`,
restores `cwd` and `fetch`, and throws when a test leaks any of them.

Why: a suite that is "usually green" is a suite nobody trusts, and a test
that reads a developer's real config passes on one machine and fails on
the next.

Enforced by: `tests/_preload.ts` (the tripwire), `scripts/test-unit.sh`
and `scripts/test-integration.sh` (the split), `TEST_ISOLATION_MISSING` in
`src/core/paths.ts`.

### 7. Prose lives in files; comments say why

Multi-line markdown, XML or prose belongs in a standalone file next to the
module that uses it, imported as text and filled with `{{PLACEHOLDER}}`
tokens. A code comment explains a constraint or a decision the code cannot
show; it does not cite plans, specs, review rounds or history, and it does
not restate the line beneath it.

Why: templates inside template literals cannot be edited without touching
source, and a comment that points at a document nobody can find is noise
that looks like information.

Enforced by: review.

### 8. Documentation describes the product that exists

One current-truth document per subsystem; no second one is forked. Plans,
decision records, review registers and future-work promises do not live
under `docs/`. Code is cited by file and symbol, not line number. A
document claims no guarantee the code does not enforce, and names no
command, flag or file that does not exist. When code and documentation
disagree, one of them is fixed in the same change.

Why: a user who reads a stale page loses more time than if the page had
not existed, and a "normative" document the code ignores teaches
contributors that documents do not matter.

Enforced by: `scripts/lint-doc-examples.ts` (every command and flag in a
doc exists), the npm pack check in
`tests/integration/install/npm-pack-contents.test.ts` (no dead link ships),
`tests/contracts/` (pinned sections of `architecture.md`, `cli.md` and
`configuration.md`).

### 9. CLI-only, Bun-first

This package is a command-line tool. There is no public API, no barrel
exports and no `exports` map; `src/cli.ts` dispatches and commands live
under `src/commands/`. Bun is the runtime and the toolchain; Node 22 is
only the npm bootstrap. Anything that would become an API for other
programs is a separate decision, not an incidental export.

Why: an accidental API is a compatibility promise nobody agreed to make.

Enforced by: `package.json` (no `exports` map, Bun scripts),
`tests/contracts/module-boundaries.test.ts`.
