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

The same rule applies to code that is not a guard: build what the current
design needs and nothing for a future one (YAGNI). No speculative option,
abstraction, extension point or "flexibility" goes in until a real caller
needs it, and a mechanism nothing calls any more comes out.

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

Enforced by: `tests/harnesses-registry.test.ts` for the registry;
`scripts/lint-secret-resolver-boundary.ts` for secret reads;
`tests/contracts/module-boundaries.test.ts` for the module table. The write
chokepoint and the no-direct-harness-imports rule are held by review; akm's
own runtime (reached from `src/integrations/agent/runner-dispatch.ts`, and not a
registered harness) and the OpenCode plugin upgrade and staleness checks still
import the OpenCode folder directly, which is open work.

### 3. One current shape per format, one converter

Each stored format has one current shape in code and one converter from older
shapes. A reader uses the converter and keeps no tolerance of its own. A user's
file (`config.json`, a task source, bundle content) is rewritten only by
`akm migrate apply`, with a backup, running that same converter; akm's own
stores (`state.db`, `index.db`) migrate forward when opened, with a backup
before any destructive step. Reads reach back to the 0.9.15 floor: above it a
reader converts in memory, warns once and names `akm migrate apply`; below it,
and for an older task source (the one named exception), the command stops and
names the migrator. What happens to data from a newer release differs by
format (a newer index layout or frozen plan is refused with "upgrade akm";
`state.db` and `config.json` warn and continue, and `akm health` reports the
config skew), so [Persisted-Data Compatibility](persisted-data-compat.md)
states the rule per format. Readers that still carry their own conversion, such
as the frozen-plan decoder, are listed there and move to the converter as they
are touched.

Why: tolerance scattered through readers is a shim nobody can delete. A
converter that the readers and the migrator share is written once, tested once
and leaves one shape behind.

Enforced by: `tests/integration/upgrade-rehearsal/`, which installs the
previous release, builds real state and runs the current build against it, and
`tests/integration/previous-release-corpus.test.ts`, which pins each older
shape as refused or converted. The compat page lists each format with its test;
a change to a format adds its old shape to the rehearsal.

### 4. Sane defaults, flexible overrides

Every default works out of the box for the common case, which for anything
touching a model means a slow local model on a single-threaded server: no
`max_tokens` sent unless asked, one timeout, concurrency one against a
loopback endpoint. Every default is overridable where it applies, per
connection or harness under `connections.<name>.*` and `harnesses.<name>.*`, per workflow step, per command flag, and
the override is honored as given. The tool never second-guesses a value
the user set; the one place it still does, clamping a workflow fan-out width
above 64, is debt rather than policy.

Why: defaults that need tuning before the first useful result lose the
user; overrides that are ignored or capped behind the user's back lose
their trust.

Enforced by: `tests/workflows/concurrency-defaults.test.ts` and
`tests/resolution.test.ts`; the rest is review.

### 5. If it matters, a test or lint checks it

Any rule we want to hold is pinned: output shapes and exit codes, the ref
grammar, the module table, the execution transport contract, that every command and
flag named in a doc exists, that shipped assets carry no dead refs. The pin
is a test under `tests/contracts/`, a unit test, or a script in the `lint`
chain. A rule nobody pinned is a preference, and may change without
ceremony.

Why: the documentation drifted from the code for months because the pages
said "normative" and nothing checked.

Enforced by: `bun run lint` (`scripts/lint-doc-examples.ts`,
`scripts/lint-shipped-assets.ts`, `scripts/lint-secret-resolver-boundary.ts`),
`tests/contracts/`, `tests/output-shapes-unit.test.ts`.

### 6. The suite is green by default and sandboxed through the environment

`test:unit` and `test:integration` report zero failures at all times. A
red run is a real break, never noise to route around; a test that must be
disabled is disabled explicitly with a linked issue. A test that opens a
real database, touches the network, or spawns a process lives under
`tests/integration/`; everything else lives under `tests/`.

Both runner scripts start every shard with its own throwaway `HOME`. The
preload then points `HOME`, the four `XDG_*_HOME` variables,
`CODEX_HOME` and `CLAUDE_CONFIG_DIR` at a sandbox and clears the `AKM_*_DIR` overrides, so code
that resolves paths from environment variables, as `src/core/paths.ts`
does, never reaches the developer's files. After each test it restores
`cwd`, `fetch` and those variables, and it throws when a test leaked any of
them. It cannot change `os.homedir()`: Bun ignores a runtime change to
`HOME`, so under a bare `bun test <file>` a default built from
`os.homedir()` reads the real home. Such a default needs its own override,
as the Codex and Claude Code session readers have `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.

Why: a suite that is "usually green" is a suite nobody trusts, and a test
that reads a developer's real config passes on one machine and fails on
the next.

Enforced by: `tests/_preload.ts` (the sandbox and the tripwire),
`scripts/test-unit.sh` and `scripts/test-integration.sh` (the split and the
per-shard `HOME`), `TEST_ISOLATION_MISSING` in `src/core/paths.ts`. Reads
through `os.homedir()` outside the runner scripts are held by review.

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
doc exists) and the npm pack check in
`tests/integration/install/npm-pack-contents.test.ts` (no dead link ships).
The rest is held by review.

### 9. CLI-first, Bun-first

This package is a command-line tool. `src/cli.ts` dispatches and commands
live under `src/commands/`. The one programmatic entry point is `akm-cli/api`
(`src/api.ts`, which exports only `curate`), so the akm plugins can recall
in-process; the `exports` map in `package.json` lists only `./api`,
`./package.json` and `./dist/*`, and there are no barrel exports. Bun is the
preferred runtime and the toolchain. Node 24 is the floor (`engines.node`):
the npm package bootstraps through Node, and its launcher falls back to Node
when no usable Bun is on `PATH`. Anything that would become another API for
other programs is a separate decision, not an incidental export.

Why: an accidental API is a compatibility promise nobody agreed to make.

Enforced by: `tests/contracts/api-surface.test.ts` (the export list),
`tests/integration/install/package-exports.test.ts` (the `exports` map),
`package.json` (`engines.node` and the `preinstall` check), and the
`node-smoke` job in `.github/workflows/ci.yml` (Node 24 and 26).

### 10. Agent harnesses are thin, replaceable internals

akm is simple, lightweight tooling for agents and automated processes. A
harness such as OpenCode (pi or another later) is an internal detail akm
uses to enable agentic work. It sits behind one thin seam, is not woven into
akm core, and can be replaced without touching the rest of akm.

Why: heavy machinery and tight coupling are the opposite of akm's goals.

Enforced by: review. The seam is `HARNESS_REGISTRY` (principle 2), which akm's own
runtime and the OpenCode plugin checks still bypass.

### 11. Simple is not sloppy

Principle 1 removes machinery that is not justified; it does not lower the
standard of what remains. Code is kept simple with SOLID structure, not
instead of it: a module has one responsibility and one reason to change;
behaviour is extended by adding a case in its one place (principle 2), not
by editing every caller; a caller depends on the narrow interface it uses,
not on the internals behind it; types say what a value is. Shrinking a diff
by merging unrelated concerns, dropping the error handling the design calls
for, or flattening clear structure into one long function is not
simplification and is reverted in review.

Why: the layers this codebase has removed were added without need, but the
remedy for over-engineering is a small clean design, not a monolith. Both
cost the next reader.

Enforced by: review; `tests/contracts/module-boundaries.test.ts` for the
module seams it pins.
