# Stability policy

`akm-cli` follows [Semantic Versioning](https://semver.org/) on the 0.x line
**with one caveat**: until 1.0, minor releases (0.x → 0.x+1) may include
breaking changes. Patch releases (0.x.y → 0.x.y+1) will not.

This document classifies each user-facing surface by stability so you can
decide which parts of `akm` are safe to script against today and which to
treat as still-evolving.

## Stable

Scripted use is supported. Behavior changes will be additive within a minor
release; breaking changes will be called out explicitly in the CHANGELOG.

- **Asset ref syntax** — `<type>:<name>` for the 11 supported asset types
  (`script`, `skill`, `command`, `agent`, `knowledge`, `memory`, `workflow`,
  `wiki`, `vault`, `lesson`, `task`).
- **Read commands** — `akm search`, `akm show`, `akm list`, `akm curate`,
  `akm info`, `akm config get`, `akm config list`, `akm vault list`,
  `akm vault show`, `akm proposals` (list filters).
- **Write commands core surface** — `akm add`, `akm update`, `akm remove`,
  `akm clone`, `akm import`, `akm save`, `akm index`, `akm setup`,
  `akm remember`, `akm feedback`, `akm config set`, `akm config unset`.
- **Output contracts** — JSON output shape (the top-level keys, error
  envelope `{ok: false, error, hint}`, exit codes from the runbook in
  `--help`).
- **Install scripts** — `install.sh` and `install.ps1` URLs; the `--prefix`
  / `AKM_INSTALL_DIR` environment override.

## Evolving

These surfaces are in active iteration as we learn from users. They will
remain available across minor releases, but flag names, prompts, and
proposal-queue shape may shift. Breaking changes will be flagged in the
CHANGELOG with a migration note.

- **Improvement loop** — `akm improve`, `akm propose`, `akm accept`,
  `akm reject`, `akm diff`, `akm revert`. Output JSON keys are stable;
  CLI flags (`--auto-accept`, `--profile`, `--task`, `--source`) may add
  options or tighten validation across releases.
- **Tasks** — `akm tasks` subcommand surface; YAML schema for scheduled
  tasks. Schema additions in patch releases; removals only at minor.
- **Wiki management** — `akm wiki *` subcommands.
- **Agent dispatch** — `akm agent` subcommand. The supported set of
  agent CLI backends (claude, opencode, codex, gemini, aider) will grow.
- **Proposal queue** — quality classifications (`accepted`, `pending`,
  `proposed`, `rejected`, `archived`) are stable; the JSON shape of a
  proposal record may add fields.

## Experimental

Subject to change without notice within minor releases. Not yet recommended
for scripted use.

- **`lesson` asset type** — schema (`when_to_use`, `description`) is
  stable, but lesson-distillation triggers and ranking are tuning targets.
- **`--detail=agent` and `--detail=summary` flags** — only implemented on
  a subset of commands; will either roll out everywhere or be replaced
  with a different mechanism.
- **Vault providers** — vault read/write is stable; external/network vault
  providers (issue #190) are not yet shipped.
- **Memory belief-state transitions** — `captureMode`, `beliefState`,
  contradiction edges, and the consolidate journal are observable but
  the algorithm that writes them is tuning across patch releases.

## On the horizon

These changes are planned and will land in a known future release. They
are not part of the current stability contract; you should plan migrations
around them.

- **0.9.0 — Bun/Node cross-runtime support** (issue #465) — 0.8 hard-
  requires Bun (or the prebuilt binary). 0.9 will support Node ≥ 22 as
  well. The CLI surface will not change; the install instructions will.
- **Storage layout consolidation**
  — under user review. Will be announced before any move happens.

## Reporting stability regressions

If you script against a stable surface and a release breaks it without a
CHANGELOG migration note, please open an issue at
<https://github.com/itlackey/akm/issues> labeled `regression`. We treat
stable-surface regressions as priority bugs.

For experimental surfaces, expect change — but file an issue if a change
isn't called out in the CHANGELOG, since that's still a documentation gap
worth fixing.

## See also

- [`CHANGELOG.md`](./CHANGELOG.md) — every release's behavior changes.
- [`SECURITY.md`](./SECURITY.md) — security supported-version policy
  (independent of feature-stability policy above).
- [`docs/data-and-telemetry.md`](./docs/data-and-telemetry.md) — what
  state akm reads and writes locally.
