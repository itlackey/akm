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

- **Asset ref syntax** — `[bundle//]conceptId[#fragment]`. A `conceptId` is
  subdir-qualified within its bundle: `memories/<name>`, `lessons/<name>`,
  `knowledge/<name>`, `skills/<name>`, `scripts/<name>`, `workflows/<name>`,
  `env/<name>`, `secrets/<name>`, and `tasks/<name>` (the `commands/`,
  `agents/`, `facts/`, and `sessions/` component directories follow the same
  rule). The optional `bundle//` prefix names an installed bundle; omit it and
  the ref resolves against the workspace `defaultBundle`, then the remaining
  bundles in installation-priority order. Durable state always stores the
  fully-qualified `bundle//conceptId`; the short (bundle-omitted) form is
  accepted input only, at the CLI, the programmatic surface, and inside bundle
  content (where it resolves against the containing bundle). The older
  `<type>:<name>` grammar is no longer accepted.
- **Read commands** — `akm search`, `akm show`, `akm list`, `akm curate`,
  `akm info`, `akm config get`, `akm config list`, `akm env list`,
  `akm secret list`, `akm proposal list` (list filters).
- **Write commands core surface** — `akm add`, `akm update`, `akm remove`,
  `akm clone`, `akm import`, `akm sync`, `akm index`, `akm setup`,
  `akm remember`, `akm feedback`, `akm config set`, `akm config unset`,
  `akm config enable`, `akm config disable`.
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
- **Runtime** — the npm package requires Node.js >= 22 as its bootstrap and
  prefers a working Bun >= 1.0 for execution when both are available; old,
  unusable, or absent Bun installations fall back to Node.js. Standalone
  binaries are runtime-free.
- **On-disk storage** — durable workspace state (events, proposals, history,
  workflow runs, salience) lives in `state.db`; the search index (`index.db`)
  is a fully **regenerable** cache rebuilt by `akm index`; high-volume logs stay
  in a separate `logs.db`. Asset metadata lives as file-local frontmatter plus
  the index (there is no separate metadata sidecar). Treat the on-disk schema
  as internal (use `akm` commands, not direct SQL).

## Evolving

These surfaces are in active iteration as we learn from users. They will
remain available across minor releases, but flag names, prompts, and
proposal-queue shape may shift. Breaking changes will be flagged in the
CHANGELOG with a migration note.

- **Improvement loop** — `akm improve`, `akm propose`, and the proposal noun
  group `akm proposal {list,show,diff,accept,reject,revert}`. Output JSON keys
  are stable; CLI flags (`--strategy`, `--task`, `--generator`) may add options
  or tighten validation across releases. `--auto-accept` is deprecated and
  ignored (proposals always queue for review).
- **Tasks** — `akm tasks` subcommand surface (singular `akm task` is an
  additive alias); strict version-2 YAML for scheduled tasks. Prompt tasks use
  named engines and task history metadata is versioned. Schema additions in
  patch releases; removals only at minor.
- **Events / log** — `akm log` is the primary event-stream surface (`akm
  history` is a different, asset-scoped surface).
- **Lessons** — `akm lessons` subcommand surface (singular `akm lesson` is an
  additive alias).
- **Bundles & the workspace model** — installed sources are *bundles*; each is
  recognized by a built-in *adapter* (native Agent Skills, Claude and OpenCode
  commands/agents, knowledge, YAML workflows, tasks, env/secret files, scripts,
  OKF and LLM-wiki knowledge bases). Config is keyed by `bundles` and
  `defaultBundle`. The adapter set, bundle-recognition rules, and the
  `bundles` config shape may still shift.
- **LLM Wiki bundles** — the Karpathy-style LLM wiki is a first-class built-in
  bundle format (the `llm-wiki` adapter owns `schema.md` / `index.md` /
  `log.md` / `raw/` / `pages/` and its ingest flow); wiki pages are addressed
  as ordinary concepts inside their bundle. Adapter behavior and page
  conventions are still iterating.
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
  (`--shape human|agent|summary`). `summary` is implemented only on
  `akm show`; `agent` is implemented on `search`, `show`, and `curate`.
  Coverage will expand. `--detail` is verbosity only (`brief|normal|full`).
- **Protected env & secret values** — `env` (a whole `.env` group; key names
  are surfaced for discoverability, values never are) and `secret` (a single
  sensitive value). Values are never written to stdout, the index, or
  structured output; the safe injection path is `akm env run <name> --
  <command>` (or `akm secret run <name> <VAR> -- …`).
- **Memory belief-state transitions** — `captureMode`, `beliefState`,
  contradiction edges, and the consolidate journal are observable but
  the algorithm that writes them is tuning across patch releases.
- **`akm mv`** — rename an asset within its type directory in the primary
  writable stash, with inbound-ref rewrite across the stash's markdown files
  and an in-place index re-key that preserves the asset's accumulated
  usage-ranking history. The JSON output shape
  (`from`/`to`/`rewrote`/`readOnlyCiters`/`utilityPreserved`), the supported
  asset-type set, and the validation rules may change while the rename flow
  matures.
- **`akm workflow run` + YAML workflow programs** — orchestrated workflows
  are written as YAML programs (`workflows/*.yaml`, `version: 2`, validated
  against `schemas/akm-workflow.json`) with `${{ … }}` expressions, per-step
  fan-out, routing, frozen per-run plans, and an explicit failure policy,
  executed engine-driven by `akm workflow run`. The engine provides journaled
  replay with content-derived unit identity (input divergence is a hard
  error), single-driver run leases, typed step artifacts, artifact-judged
  gates with bounded `max_loops` and required gates (`gate.required`, or the
  run-wide `akm workflow run --require-gates`, which BLOCK for a human
  instead of failing open when no judge is available), run budget ceilings
  (`budget.max_tokens`/`max_units`), the engine concurrency cap knob
  (`workflow.maxConcurrency` config; unset = `min(16, max(1, cores − 2))`,
  explicit values clamped to `[1, 64]`), `akm workflow watch` (NDJSON event
  tail, `--stream`), and `isolation: worktree`. A
  **harness-neutral driver protocol** lets any agent session (Claude Code,
  opencode, Codex, a human at a shell) drive a run instead of the native
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
  Every report command carries `--expect-step` (refused if the spine has
  moved), and `report --settle` (no `--unit`) advances a step that dispatches
  no reportable units — a params-only route, an empty fan-out, or an
  all-unresolvable work-list — so a driver never wedges.
  A run is driven by one engine OR one external driver
  at a time (the run lease arbitrates; `report` is refused while a live
  engine lease exists), and the two surfaces produce identical unit graphs.
  The YAML format, its schema, the `run`/`watch`/`brief`/`report` flags, and
  all JSON output shapes (including `workflow-brief`/`workflow-report`) may
  all change while the orchestration engine matures. Classic
  **linear markdown workflows are unchanged and stable**, as is the workflow
  CLI contract (`start`/`next`/`complete`/`status`/`list`).

## On the horizon

These changes are planned and will land in a known future release. They
are not part of the current stability contract; you should plan migrations
around them.

- **1.0 contract freeze** — the `[bundle//]conceptId` ref grammar, the
  supported source model, search behavior, and write-target rules are frozen at
  1.0. The SDK and in-process plugin story ship on top of that frozen core.

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
- [`docs/reference/data-and-telemetry.md`](./docs/reference/data-and-telemetry.md) — what
  state akm reads and writes locally.
