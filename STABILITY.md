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
  `wiki`, `vault`, `lesson`, `task`). The `vault` asset type is deprecated
  (removed in 0.9.0 — use `env`); it continues to resolve to frozen `vaults/`
  files for the 0.8 window.
- **Read commands** — `akm search`, `akm show`, `akm list`, `akm curate`,
  `akm info`, `akm config get`, `akm config list`, `akm vault list`,
  `akm vault show`, `akm proposal list` (list filters). The flat `akm proposals`
  spelling is a deprecated alias (removed in 0.9.0).
- **Write commands core surface** — `akm add`, `akm update`, `akm remove`,
  `akm clone`, `akm import`, `akm sync`, `akm index`, `akm setup`,
  `akm remember`, `akm feedback`, `akm config set`, `akm config unset`,
  `akm config enable`, `akm config disable`. `akm save` (now `akm sync`) and the
  top-level `akm enable` / `akm disable` (now `akm config enable` /
  `akm config disable`) are deprecated aliases that warn on stderr and delegate
  (removed in 0.9.0). On `akm feedback`, `--note` is a deprecated alias for
  `--reason` (removed in 0.9.0).
- **Output contracts** — JSON output shape (the top-level keys, error
  envelope `{ok: false, error, hint}`), and the exit-code table below.
  `--detail` is verbosity only (`brief|normal|full`); `--shape`
  (`human|agent|summary`) is the output-projection axis (see Experimental).

  | Exit code | Meaning |
  | --- | --- |
  | `0` | Success |
  | `1` | General error / not found |
  | `2` | Usage / bad input |
  | `4` | Health warning (`akm health` only) |
  | `78` | Configuration error |
- **Install scripts** — `install.sh` and `install.ps1` URLs; the `--prefix`
  / `AKM_INSTALL_DIR` environment override.

## Evolving

These surfaces are in active iteration as we learn from users. They will
remain available across minor releases, but flag names, prompts, and
proposal-queue shape may shift. Breaking changes will be flagged in the
CHANGELOG with a migration note.

- **Improvement loop** — `akm improve`, `akm propose`, and the proposal noun
  group `akm proposal {list,show,diff,accept,reject,revert}`. The flat verbs
  `akm proposals`, `akm show proposal`, `akm accept`, `akm reject`, `akm diff`,
  and `akm revert` are deprecated aliases that warn on stderr and delegate
  (removed in 0.9.0). Output JSON keys are stable; CLI flags (`--auto-accept`,
  `--profile`, `--task`, `--generator`) may add options or tighten validation
  across releases. On `accept`/`reject`/`history`, `--source` is a deprecated
  alias for `--generator` (removed in 0.9.0).
- **Tasks** — `akm tasks` subcommand surface (singular `akm task` is an
  additive alias); YAML schema for scheduled tasks. Schema additions in patch
  releases; removals only at minor.
- **Events / log** — `akm events` subcommand surface (`akm log` is an additive
  alias for the same stream in 0.8; `log` becomes primary in 0.9.0).
- **Lessons** — `akm lessons` subcommand surface (singular `akm lesson` is an
  additive alias).
- **Wiki management** — `akm wiki *` subcommands. `akm wiki remove` now confirms
  before deleting; pass `-y` / `--yes` to skip the prompt. The old
  `--force` flag is a deprecated alias for `-y` (removed in 0.9.0).
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
- **`--shape agent` and `--shape summary`** — the output-projection axis
  (`--shape human|agent|summary`) is new in 0.8. `summary` is implemented
  only on `akm show`; `agent` is implemented on `search`, `show`, and
  `curate`. Coverage will expand. The legacy spellings `--detail summary`,
  `--detail agent`, and `--for-agent` are deprecated aliases (warn on
  stderr; removed in 0.9.0). `--detail` is now verbosity only
  (`brief|normal|full`).
- **Vault providers** — vault read/write is stable; external/network vault
  providers (issue #190) are not yet shipped.
- **Memory belief-state transitions** — `captureMode`, `beliefState`,
  contradiction edges, and the consolidate journal are observable but
  the algorithm that writes them is tuning across patch releases.
- **`akm workflow run` + YAML workflow programs** — orchestrated workflows
  are written as YAML programs (`workflows/*.yaml`, `version: 1`, validated
  against `schemas/akm-workflow.json`) with `${{ … }}` expressions, per-step
  fan-out, routing, frozen per-run plans, and an explicit failure policy,
  executed engine-driven by `akm workflow run`. The R2 engine rework adds
  journaled replay with content-derived unit identity (input divergence is a
  hard error), single-driver run leases, typed step artifacts,
  artifact-judged gates with bounded `max_loops` and required gates
  (`gate.required`, or the run-wide `akm workflow run --require-gates`, which
  BLOCK for a human instead of failing open when no judge is available), run
  budget ceilings (`budget.max_tokens`/`max_units`), `akm workflow watch`
  (NDJSON event tail, `--stream`), and `isolation: worktree`. The R3 rework
  adds a
  **harness-neutral driver protocol** so any agent session (Claude Code,
  opencode, Codex, a human at a shell) can drive a run instead of the native
  engine: **`akm workflow brief <run>`** (read-only; takes no lease and
  mutates nothing) emits the active step's expected work-list — per-unit
  resolved instructions, output schema, env binding NAMES only, timeout,
  and the exact report command lines — and **`akm workflow report <run>
  --unit <id> --status completed|failed|running`** (the one mutating verb)
  ingests a unit's result through the SAME shared step semantics the engine
  uses, enforcing input-hash idempotency/replay-divergence, output-schema
  validation, budget ceilings, and the artifact-judged gate/`max_loops`
  completion path. A same-hash re-report of a completed unit is an idempotent
  no-op; `--rerun` records a fresh attempt for a failed unit. `--status
  running` claims/heartbeats a unit (a claim holder + expiry, and
  `last_checkin_at`) for stale-driver detection without advancing the spine.
  A run is driven by one engine OR one external driver
  at a time (the run lease arbitrates; `report` is refused while a live
  engine lease exists), and the two surfaces produce identical unit graphs.
  The YAML format, its schema, the `run`/`watch`/`brief`/`report` flags, and
  all JSON output shapes (including `workflow-brief`/`workflow-report`) may
  all change while the orchestration engine matures. (This format replaced
  the never-released P1 markdown orchestration subsections.) Classic
  **linear markdown workflows are unchanged and stable**, as is the workflow
  CLI contract (`start`/`next`/`complete`/`status`/`list`).

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
