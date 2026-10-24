# akm Core Principles

How akm is built. These are the rules the code, the tests and the
documentation in this repository follow. What akm does for a user is
described in [Architecture](architecture.md); the product invariants that
used to live here are its "Invariants" section.

Each principle states the rule, why it exists, and what enforces it. A rule
with nothing enforcing it is held by review, and says so.

## Precedence

When two principles pull against each other: a user's data comes first,
then honesty (code and documentation that do what they say), then
simplicity, then convenience. A principle marked as a goal not yet reached
does not make the code wrong where it falls short; it names the work.

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

### 3. Decide once, then freeze

Anything that changes what a durable run does is resolved when the run is
created and journaled with it: the plan, the resolved request, the engine,
the fan-out width, the parameter snapshot. A resumed run reads the journal,
never config, model aliases or credentials. Editing config changes the next
run, not the one in flight.

Why: a run that can change underneath itself cannot be resumed, reasoned
about, or reproduced.

Enforced by: `tests/workflows/child-plan-immutability.test.ts`,
`tests/workflows/immutable-execution-v4-red.test.ts`,
`tests/concurrency-defaults.test.ts`.

### 4. Readers tolerate the past and refuse only the future

Data an older release wrote is read: converted in memory, warned about
once, and left for `akm migrate apply` to rewrite on disk. The migrator is
the on-disk rewrite path, never a precondition for reading. The only data a
reader refuses is data a newer release wrote, and the refusal names the
upgrade. No config object is strict: an unknown key at any depth is kept,
named once, and round-trips through ordinary writes.

Why: an upgrade that strands a user's data on the first command is worse
than any inconsistency it was guarding against.

Enforced by: `tests/integration/upgrade-rehearsal/`, which installs the
previous release, builds real state, and runs the candidate against it.
[Persisted-Data Compatibility](persisted-data-compat.md) is the per-format
contract; every format change adds its old shape to the rehearsal.

### 5. Runtime code never invents authority

Sources, defaults, registries, credentials, scheduled tasks and execution
policy come from this host's own config. Inherited config (`extends`)
shares portable policy only. A disabled bundle is inert for reads, writes,
indexing and execution. The default bundle is carried explicitly, never
inferred from array position. The single exception, a config without
`scheduler.enabled` adopting the scheduler rows akm already wrote on this
host, is documented and is the only one.

Why: a tool that fills in trust decisions on its own becomes impossible to
audit, and every "helpful" inference is a path a bundle author can abuse.

Enforced by: `tests/config.test.ts` (`HOST_LOCAL_CONFIG_KEYS` in
`src/core/config/config.ts`) and `tests/core/activation-policy.test.ts`.

### 6. Safe defaults, narrow overrides

Defaults work for the lowest common denominator: a slow local model on a
single-threaded server. No `max_tokens` is sent unless configured, one
timeout knob, concurrency one for a loopback endpoint, no per-call tuning
knobs without a strong reason. An override that weakens a safety rule names
exactly one risk: `--allow-insecure-transport` is for plain HTTP and
nothing else, `--allow-dangerous-env-keys` is for reviewed
process-hijacking environment keys and nothing else. There is no combined
bypass.

Why: a knob nobody needed is a surface nobody tested; a combined bypass is
a flag people cargo-cult.

Enforced by: `tests/concurrency-defaults.test.ts`,
`tests/env-run-dangerous-key-block.test.ts`; the rest is review.

### 7. A contract is a test or a lint, or it is a preference

Output shapes, exit codes, the ref grammar, the module table, the engine
boundary, documentation examples that name real commands and flags, shipped
assets that carry no dead refs: each is pinned. A rule that matters gets a
pin in `tests/contracts/`, a unit test, or a script in the `lint` chain. A
rule nobody pinned is a preference and may be changed without ceremony.

Why: this repository's documentation drifted from its code for months
because the documents said "normative" and nothing checked.

Enforced by: `bun run lint` (`scripts/lint-doc-examples.ts`,
`scripts/lint-shipped-assets.ts`, `scripts/lint-secret-resolver-boundary.ts`),
`tests/contracts/`, `tests/output-shapes-unit.test.ts`.

### 8. The suite is green by default and isolated by construction

`test:unit` and `test:integration` report zero failures at all times; a red
run is a real break, never noise to route around, and a test that must be
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

### 9. Prose lives in files; comments say why

Multi-line markdown, XML or prose belongs in a standalone file next to the
module that uses it, imported as text and filled with `{{PLACEHOLDER}}`
tokens. A code comment explains a constraint or a decision the code cannot
show; it does not cite plans, specs, review rounds or history, and it does
not restate the line beneath it.

Why: templates inside template literals cannot be edited without touching
source, and a comment that points at a document nobody can find is noise
that looks like information.

Enforced by: review.

### 10. Documentation describes the product that exists

One current-truth document per subsystem; no second one is forked. Plans,
decision records, review registers and future-work promises do not live
under `docs/`. Code is cited by file and symbol, not line number. A
document claims no guarantee the code does not enforce, and names no
command, flag or file that does not exist. When code and documentation
disagree, one of them is fixed in the same change, never left for later.

Why: a user who reads a stale page loses more time than if the page had
not existed, and a "normative" document the code ignores teaches
contributors that documents do not matter.

Enforced by: `scripts/lint-doc-examples.ts` (every command and flag in a
doc exists), the npm pack check in
`tests/integration/install/npm-pack-contents.test.ts` (no dead link ships),
`tests/contracts/` (pinned sections of `architecture.md`, `cli.md` and
`configuration.md`).

### 11. CLI-only, Bun-first

This package is a command-line tool. There is no public API, no barrel
exports and no `exports` map; `src/cli.ts` dispatches and commands live
under `src/commands/`. Bun is the runtime and the toolchain; Node 22 is
only the npm bootstrap. Anything that would become an API for other
programs is a separate decision, not an incidental export.

Why: an accidental API is a compatibility promise nobody agreed to make.

Enforced by: `package.json` (no `exports` map, Bun scripts),
`tests/contracts/module-boundaries.test.ts`.
