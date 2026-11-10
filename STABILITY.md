# Stability policy

`akm-cli` follows [Semantic Versioning](https://semver.org/) on the 0.x line
**with one caveat**: while the version is 0.x, minor releases (0.x → 0.x+1)
may include breaking changes.

The 0.10 release notes (the version floor, merged CLI spellings, connections
and harnesses, version numbers) are in the
[0.9 to 0.10 migration guide](docs/migration/v0.9-to-v0.10.md). The 0.11 breaking
changes are in the [0.10 to 0.11 migration guide](docs/migration/v0.10-to-v0.11.md).

This document classifies **every** user-facing surface by stability so you can
decide which parts of `akm` are safe to script against today and which to
treat as still-evolving. If a surface is not listed here, that is a bug —
please file it.

## How to read this

| Tier | Contract |
| --- | --- |
| **Stable** | Scripted use is supported. Changes are additive within a minor release; breaking changes are called out in the CHANGELOG with a migration note. |
| **Evolving** | Available across minor releases, but flag names, prompts, and payload shapes may shift. Breaking changes are flagged in the CHANGELOG. |
| **Experimental** | Subject to change without notice. Not recommended for scripted use. Some experimental surfaces additionally require an explicit opt-in — see [`akm improve` autonomy](#akm-improve-autonomy). |
| **Internal** | Not a public interface. May change or disappear in any release, without a CHANGELOG note. Listed here only so you can recognize it. |

## 1.0 contract

What consumers (the akm plugins, AKM Desktop, scripts and scheduled tasks)
already depend on. It adds no commitment beyond what the tables below already
say, and the 1.0 freeze covers these items and nothing else: the
`[bundle//]conceptId[#fragment]` ref grammar, the supported source model, search
behavior and the write-target rules. The SDK and in-process plugin story ship on
top of that frozen core.

**Output envelope.** The envelope is not one shape; each command keeps its own,
and `--format json` prints it. These are the shapes as they stand:

| Command | Top-level keys that identify the result |
| --- | --- |
| `search`, `show`, `proposal list`, `log`, `config get` | None: the bare result (`config get` prints the bare value; `--show-source` wraps it as `{ value, source }`) |
| `curate`, `env list`, `secret list` | `shape` and `schemaVersion`, no `ok` |
| `migrate status` | `ok` and `schemaVersion`, no `shape` |
| `info` | `ok` and `schemaVersion`, no `shape` |
| Commands emitted through the passthrough stamp (for example `config list`) | `ok`, `shape` and `schemaVersion` |

`search` and `curate` list their matches under one key, `results` (`hits` and
`items` are gone; `akm search` adds `registryHits` for registry matches, a separate
list with its own shape; the workspace API's `assets.search` uses `results` too). Only the commands in the last four rows carry `schemaVersion`, and only those in
the second and last rows carry `shape`: a script reads them there and nowhere
else. AKM Desktop's child-process runner
(`src/workspace/cli-child.ts`) requires `shape` equal to the expected shape and
an integer `schemaVersion`, and rejects `ok: false`.

**Failure.** A failed command prints `{ "ok": false, "error", "code"?, "hint" }`
to stderr and exits non-zero. The exit codes are in the
[CLI reference](docs/reference/cli.md#exit-codes-and-error-envelope).

**Plugin call set.** The akm plugins call only these: `info`, `curate`, `search`
(`--type`, `--by-usage`, `--project`), `show`, `feedback`, `remember`, `proposal
new|list|show|diff|extract`, `config get defaultBundle`, `setup --learning`,
`index` and `--version`, and they set `AKM_EVENT_SOURCE` so a run's reads and
feedback are attributed to it. `info.learning`, `setup --learning` and
`AKM_EVENT_SOURCE` are Stable for that reason.

**Not frozen.** The `state.db` and `index.db` schemas, the `dist/` layout,
`akm-cli/workspace`, harness internals and the eval seams
(`AKM_EMBED_DETERMINISTIC`) may change in any
release.

## Command tier index

The canonical index: every command and subcommand group in the current tree
(enumerated from `main.subCommands` in `src/cli.ts` and each group's own
`subCommands`), with its tier. The sections below explain what each tier
covers beyond the table.

| Command | Tier | Notes |
| --- | --- | --- |
| `akm setup` | Stable | The answer flags (`--endpoint`, `--api-key-env`, `--name`, `--harness`, `--embedding`, ...) are new in 0.10; the old `--config <json>` (an answers file) and `--probe` are gone (see the [migration guide](docs/migration/v0.9-to-v0.10.md)); `--config <file>` is now the global config-file selector, so on `setup` it names the config file to write. `--learning on|off` is Stable; the `improve.enabled` config key it writes is Experimental. |
| `akm index` | Stable | `--export-vectors` and `--import-vectors` are Experimental for their first release; the vector file (`model`, `text_hash`, `embedding`) is their contract, the index file format stays internal. |
| `akm health` | Evolving | Exit codes are Evolving; report *content* and rendered `md` layout are Experimental — do not script against report layout. |
| `akm metrics` | Experimental | New in 0.9.28. Report content and JSON shape may change. |
| `akm info` | Stable | The `learning` field is Stable. |
| `akm bundle create` | Stable | |
| `akm bundle add` | Stable | |
| `akm bundle list` | Stable | |
| `akm bundle show` | Evolving | |
| `akm bundle rename` | Stable | |
| `akm bundle remove` | Stable | |
| `akm bundle update` | Stable | |
| `akm upgrade` | Stable | Including the plugin step and `--next`. Checksum verification is on by default; `--skip-checksum` is the recovery hatch for an unreachable `checksums.txt` (Evolving). |
| `akm search` | Stable | |
| `akm curate` | Stable | |
| `akm show` | Stable | |
| `akm workflow status` | Experimental | `--all-scopes` added in 0.9.15 (#942) and removed in 0.10 (#1239). |
| `akm workflow plan` | Experimental | New in 0.9.2; secret-free provenance output; envelope shape may change. |
| `akm workflow list` | Experimental | `--all-scopes` and a top-level `scopeKey` envelope field added in 0.9.15 (#942); since 0.10 (#1239) `--all-scopes` is removed, and the `scopeKey` field is removed from the list result. |
| `akm workflow create` | Experimental | |
| `akm workflow resume` | Experimental | |
| `akm workflow abandon` | Experimental | |
| `akm workflow run` | Experimental | Starts a run from a workflow ref or drives an existing run by id; `workflow resume` reopens a blocked or failed run first. |
| `akm remember` | Stable | |
| `akm import` | Stable | |
| `akm sync` | Stable | |
| `akm clone` | Stable | |
| `akm registry list` | Evolving | |
| `akm registry add` | Evolving | |
| `akm registry remove` | Evolving | |
| `akm migrate status` | Internal | Forwards to the standalone `akm-migrate` tool and renders its result through the normal `--format` pipeline. |
| `akm migrate apply` | Internal | Forwards to the standalone `akm-migrate` tool and renders its result through the normal `--format` pipeline. |
| `akm config path` | Stable | |
| `akm config list` | Stable | |
| `akm config get` | Stable | Default bare-value shape unchanged; `--show-source` (opt-in) wraps it as `{ value, source }`. |
| `akm config set` | Stable | |
| `akm config unset` | Stable | |
| `akm config diff` | Evolving | Compares the effective config with another config file. |
| `akm feedback` | Stable | |
| `akm log` | Evolving | |
| `akm agent` | Evolving | |
| `akm command` | Evolving | Runs stored command templates through the same agent dispatch as `akm agent`. |
| `akm models` | Evolving | The alias picks of a connection, then the models its endpoint lists, and `set` to change one. |
| `akm lint` | Evolving | |
| `akm improve` | Evolving | Review-first by default; mutating lanes require `experimental.improveAutonomy` — see below. |
| `akm improve report` | Evolving | Subcommand since 0.10 (was a magic `scope` value); owns `--run` and `--since`. |
| `akm judge` | Evolving | Runs a registered judge (`reflect.quality`, `distill.lesson`, `consolidate.pair`, `proposal.judgment`) on one JSON input from stdin, on the runner `--connection`, `--harness` and `--model` select. Output is one envelope (`judge`, `schemaVersion`, `runner`, `outcome`, `verdict?`, `reason?`); each judge carries its own `schemaVersion`. |
| `akm proposal list` | Stable | |
| `akm proposal show` | Evolving | The `legacy-ref` validation finding on a proposal recorded before concept IDs (#1513) is Experimental for its first release. |
| `akm proposal diff` | Evolving | |
| `akm proposal accept` | Evolving | |
| `akm proposal reject` | Evolving | |
| `akm proposal reopen` | Evolving | Undoes a rejection. |
| `akm proposal revert` | Evolving | |
| `akm proposal drain` | Evolving | |
| `akm proposal extract` | Evolving | Former top-level `akm extract`. Promoted from Experimental in 0.10 (#1133): the extract eval measures it. Evolving, not Stable, because 0.10 is still settling the improve defaults. |
| `akm proposal new` | Evolving | Former top-level `akm propose`. |
| `akm help` | Stable | |
| `akm hints` | Stable | Format-exempt agent guide; one short guide; `--detail` is ignored. |
| `akm completions` | Stable | Format-exempt (emits shell script source). |
| `akm env list` | Stable | Read-and-inject surface. |
| `akm env path` | Stable | Read-and-inject surface. |
| `akm env export` | Stable | Read-and-inject surface. |
| `akm env run` | Stable | Read-and-inject surface. |
| `akm env create` | Experimental | Write verb. |
| `akm env remove` | Experimental | Write verb. |
| `akm secret list` | Stable | Read-and-inject surface. |
| `akm secret run` | Stable | Read-and-inject surface. |
| `akm secret set` | Experimental | Write verb. |
| `akm secret remove` | Experimental | Write verb; restored in 0.10 after its 0.9.0 removal. |
| `akm task add` | Evolving | |
| `akm task enable` | Evolving | |
| `akm task disable` | Evolving | |
| `akm task dispatch` | Evolving | The one command the OS scheduler entry runs every minute. |
| `akm task run` | Evolving | |
| `akm task history` | Evolving | |
| `akm task sync` | Evolving | |
| `akm task doctor` | Evolving | |
| `akm task explain` | Evolving | New in 0.9.2; secret-shaped values in provenance output are redacted on a best-effort heuristic basis (not a guarantee). |

## Stable

- **Asset ref syntax** — `[bundle//]conceptId[#fragment]`. A `conceptId` is
  subdir-qualified within its bundle: `memories/<name>`, `lessons/<name>`,
  `knowledge/<name>`, `skills/<name>`, `scripts/<name>`, `workflows/<name>`,
  `env/<name>`, `secrets/<name>`, `tasks/<name>`, `facts/<name>`,
  `sessions/<name>`, `commands/<name>`, `agents/<name>`. Other adapters
  declare their own conceptId layouts. The optional `bundle//` prefix names an
  installed bundle; omit it and the ref resolves against the workspace
  `defaultBundle`, then the remaining bundles in installation-priority order.
  Durable state always stores the fully-qualified `bundle//conceptId`; the
  short form is accepted input only, at the CLI, the programmatic surface, and
  inside bundle content (where it resolves against the containing bundle). The
  older `<type>:<name>` grammar is no longer accepted.
  - `#fragment` is **input-only** and never stored. On markdown-document items
    the core resolves it as a section selector — `akm show <ref>#<heading-slug>`
    returns that one section, no fragment returns the whole item, and an
    unmatched fragment lists the available slugs. A whole document's `show`
    carries `toc`, every heading with the slug that selects it. On any other item
    `akm show` ignores the fragment with a warning and shows the whole item. See
    [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md).
  - **Refs in prose** must be fully qualified (`bundle//conceptId`) or a native
    adapter link form. A bare conceptId in prose is ordinary text, not a ref.
- **ConceptId-prefix enumeration** — `akm search "memories/"`,
  `"memories/projecta/"`, `"bundle//"`, `"bundle//skills/"`. A trailing `/` is
  required. The prefix matches the **conceptId** — the spelling every emitted
  `ref` carries — so a ref copied out of search output can be truncated to a
  prefix and pasted back in. Enumeration is not tied to any adapter's type set,
  so every adapter's items browse the same way, and `bundle//` lists a whole
  bundle (this replaced `akm bundle items`). A prefix is explicit intent, so
  `search.defaultExcludeTypes` does not apply to it. The pre-0.9.0
  `"<type>:"` / `"<type>:<prefix>/"` spelling was removed; a query in that
  shape is now an ordinary keyword search whose empty-result tip names the
  conceptId spelling that replaces it.
- **Read commands** — `akm search`, `akm show`, `akm bundle list`, `akm curate`,
  `akm info`, `akm config get`, `akm config list`, `akm config path`,
  `akm env list`, `akm secret list`, `akm proposal list` (list filters),
  `akm help`, `akm hints`, `akm completions`.
- **Write commands core surface** — `akm bundle add`, `akm bundle update`,
  `akm bundle remove`, `akm clone`, `akm import`, `akm sync`, `akm index`,
  `akm bundle create`, `akm setup`, `akm remember`, `akm feedback`,
  `akm config set`, `akm config unset`.
- **Renames are delete + create** — moving or renaming an item gives it a new
  identity; learned state (feedback, usage, salience) does not follow it.
  Cross-bundle movement is copy/import plus delete. Move the file, then run
  `akm index`, then `akm lint` to catch inbound refs the move left dangling.
  There is no `akm mv`; `scripts/rekey-asset-ref.ts` re-keys earned signal from
  an old ref to a new one and is Internal tooling.
- **Asset `type` is a free-form, open string** — `--type` filtering is an
  exact match against an open set and is deliberately **not validated**: an
  unrecognized type returns zero hits, not an error. Adapters emit types
  outside the built-in set, so there is no closed list to validate against —
  `--type website` or `--type wiki-source` are ordinary, valid filters.
- **Output contracts** — JSON output shape (the top-level keys) and the error
  envelope `{ok: false, error, code?, hint?}` on envelope surfaces: `ok` and
  `error` are always present; `code` is a stable machine-readable identifier
  present on every classified failure (exit 1 / 2 / 78) and absent only on
  unexpected internal errors (exit 70); `hint` is best-effort and may be absent. Prefer
  `code` over matching on `error` prose. Plus the exit-code table below.
  **All five** `--format` values (`json|jsonl|yaml|text|md`) are available
  on every non-exempt command. `json`, `jsonl`, and `yaml` serialize the
  envelope; `text` and `md` render it. A command may register a bespoke
  renderer for a document format — `akm health` does, for its per-run and
  window-compare tables — and anything unregistered
  falls back to a generic rendering derived from the envelope's own shape. No
  command emits one format's bytes when another was asked for, none rejects a
  supported format outright (`html` was removed with `akm ui` and is refused with a usage error naming AKM Desktop and `--format md`), and **no command reads `--format` to decide what data to
  fetch**: a registered renderer fires on the shape of the result (`akm health
  --report` carries the report dataset in the envelope, so the same data is
  available as JSON), never on the format alone.
  `--detail` is `brief|normal|full`; any other value warns once and uses `normal`. A small set of commands is **format-exempt** because their
  output is not a result envelope at all: `completions` (shell script source),
  child-process passthrough in `env run` / `secret run`, a bare-path payload
  from `env path` and `config path`, and document payloads from `help`. The set is declared in
  `src/output/format-exempt.ts`, and
  passing `--format` to one of them warns rather than silently doing something
  else. Scripted `setup` modes emit a normal format-aware result; interactive
  `setup` is a terminal UI and emits no result document. `agent` leaves
  inherited child streams raw and formats its final result envelope.
  `migrate status`/`apply` both spawn the standalone `akm-migrate` tool but are
  NOT in the exempt set: `src/commands/migrate-cli.ts` parses the child's
  final JSON result line and renders it through the same `output()` pipeline
  (registered shape `src/output/shapes/migrate.ts`, text renderer
  `src/output/text/migrate.ts`), so all five `--format` values work on them
  like any other command. Any progress-event lines the child prints during a
  real `apply` (content migration, proposal-ref repair) still print verbatim,
  ahead of the formatted result — those are operational logging, not part of
  the result envelope.

  | Exit code | Meaning |
  | --- | --- |
  | `0` | Success |
  | `1` | Not found / command-reported failure |
  | `2` | Usage / bad input |
  | `4` | Health warning (`akm health` only) |
  | `70` | Internal / unclassified |
  | `75` | Transient — retry shortly (`TransientError`, sysexits `EX_TEMPFAIL`); another akm process holds a lock or is writing `state.db` or `index.db` right now |
  | `78` | Configuration or environment error (`ConfigError`), including `SCHEDULER_UNAVAILABLE` |

- **Install scripts** — the `install.sh` and `install.ps1` URLs and the
  `AKM_INSTALL_DIR` environment override.
- **Runtime** — the npm package requires Node.js >= 22 as its bootstrap and
  prefers a working Bun >= 1.0 for execution when both are available; old,
  unusable, or absent Bun installations fall back to Node.js. Standalone
  binaries are runtime-free.
- **On-disk storage** — durable workspace state (events, proposals, history,
  workflow runs, salience) lives in `state.db`; the search index (`index.db`)
  is a fully **regenerable** cache rebuilt by `akm index`; high-volume logs stay
  in a separate `logs.db`; the history older than `state.db`'s 90 days of raw rows
  (daily rollups and every improve run) lives in `metrics.db`, which is **not**
  regenerable and is never purged. Asset metadata lives as file-local frontmatter plus
  the index (there is no separate metadata sidecar). Treat the on-disk schema
  as internal (use `akm` commands, not direct SQL).

## Evolving

These surfaces are in active iteration as we learn from users. They will
remain available across minor releases, but flag names, prompts, and
proposal-queue shape may shift. Breaking changes will be flagged in the
CHANGELOG with a migration note.

- **Programmatic API** — `akm-cli/api` (`curate()`, for in-process recall by the akm plugins; see [`docs/reference/api.md`](docs/reference/api.md)). The recall export list only grows and `curate()`'s parameters and result keep their documented contract; the text it returns is `akm curate --detail normal` output and changes with it. The separate workspace namespace is Experimental, below.
- **Improvement loop** — `akm improve` and the proposal noun group
  `akm proposal {extract,new,list,show,diff,accept,reject,reopen,revert,drain}`
  (`extract` and `new` are the former top-level `akm extract`/`akm propose`,
  moved under `proposal` in 0.9.0). Output JSON keys
  are stable; CLI flags (`--strategy`, `--task`, `--generator`) may add
  options or tighten validation across releases. `akm improve` stays on by
  default and is **review-first**: the lanes that mutate assets without review
  require `experimental.improveAutonomy` — see
  [`akm improve` autonomy](#akm-improve-autonomy).
  `--auto-accept` was removed in 0.9.0 and is an unknown flag (a usage error,
  exit 2) since 0.10. The replacement is
  `akm improve && akm proposal drain --promote --yes`, or a `triage` block
  with `applyMode: "promote"` in your strategy.
  **Session extraction** (`akm proposal extract` and the improve `extract`
  process) is Evolving as of 0.10 (#1133): the extract eval (insights saved,
  routine sessions left empty, planted instructions refused) is its gate. It
  is Evolving, not Stable, because 0.10 is still settling the improve
  defaults; what it extracts and its output may still be tuned.
- **Tasks** — `akm task` subcommand surface (`add | enable | disable | run |
  explain | history | sync | prune | doctor`; no alias, no
  `list`/`remove`/`init`/`validate`); task source v4 YAML (typed
  `inputs:`, optional `schedule:`) is the only accepted version — task v3 and
  task v2 sources are converted by `akm migrate apply`. Command tasks use
  a named connection or harness, and task history metadata is versioned. Schema additions in
  patch releases; removals only at minor. Bare `akm task` is a usage error
  naming the subcommands (`akm task doctor` reports scheduler diagnostics).
  `akm task explain <ref>` (new in 0.9.2) and `akm workflow plan <ref>` are
  both zero-write provenance surfaces: they show what a task or workflow
  would do — resolved target, input bindings, child expansion — without
  starting or publishing a run. `akm workflow plan` is secret-free **by
  construction** (the excluded data never reaches the command). `akm task
  explain` instead **redacts** secret-shaped input values on a best-effort
  heuristic basis — a value that doesn't match the heuristic can still
  print unredacted.
- **Workflow plan** — `akm workflow plan <ref>`, new in 0.9.2: zero-write
  compile+freeze introspection (the canonical step graph, task/child
  expansion, input bindings, and lowering notices for a workflow, without
  starting or publishing a run). The envelope shape may still change. Like every
  `workflow` verb it is Experimental from 0.9.28 (see Experimental below).
- **Events / log** — `akm log` is the event-stream surface (0.9.0: the
  asset-scoped `akm history` surface, and `log`'s own `tail` subcommand, were
  both removed; `log` is now a leaf command — the former `list` surface).
- **Bundles & the workspace model** — installed sources are *bundles*; each is
  recognized by a built-in *adapter* (native Agent Skills, Claude and OpenCode
  commands/agents, knowledge, workflows, tasks, env/secret files, scripts,
  OKF and LLM-wiki knowledge bases). Config is keyed by `bundles` and
  `defaultBundle`. The adapter set, bundle-recognition rules, and the
  `bundles` config shape may still shift; the `okf`, `llm-wiki` and
  `generic-files` adapters in particular are Evolving. Bundles are inspected through
  `akm bundle list` / `akm bundle show <name>` and enumerated through
  `akm search "bundle//"`. (An earlier `akm bundle items` noun group was
  removed in 0.9.0 as duplicative of `akm search`; the current `akm bundle`
  group — `create | add | list | show | rename | remove | update` — is the
  lifecycle-management surface consolidated from the former top-level
  `init`/`add`/`list`/`remove`/`update` commands, not a revival of that one.)
  OKF is the
  first-class baseline for Markdown concept identity and generic reads; every
  applicable OKF conformance case is required to pass. AKM-authored Markdown is
  an OKF-compatible superset whose adapter adds native behavior progressively.
- **LLM Wiki bundles** — the Karpathy-style LLM wiki is a first-class built-in
  bundle format (the `llm-wiki` adapter owns `schema.md` / `index.md` /
  `log.md` / `raw/` / `pages/` and its ingest flow); wiki pages are addressed
  as ordinary concepts inside their bundle. Adapter behavior and page
  conventions are still iterating.
- **Agent dispatch** — `akm agent` and `akm command`. Supported
  harnesses: `claude`, `codex`, `opencode` (through `opencode run`, for OpenCode 2
  and for the legacy OpenCode 1, which keeps working with no removal date),
  `copilot`, `pi`, `gemini`, `aider`, `amazonq` and `openhands`. Every harness is Evolving: a harness is a thin shell that turns a
  request into a command, and the set is easy to add to, remove from and update.
  The set will grow. A harness runs with your environment as it is
  ([Configuration](docs/reference/configuration.md#how-akm-runs-a-harness)). With
  no harness configured, agent work runs on akm's own runtime over a connection,
  which is Evolving too.
- **Model aliases** — `akm models` and `akm models set`, and the intent-alias
  picks a connection holds.
- **Proposal queue** — quality classifications (`accepted`, `pending`,
  `proposed`, `rejected`, `archived`) are stable; the JSON shape of a
  proposal record may add fields.
- **Registries** — `akm registry {list,add,remove}`. Searching registries is
  `akm search --from registry` (0.9.0: `registry search` was folded into
  `search`). Building a registry index is maintainer tooling (Internal) and
  lives outside the CLI, in `scripts/build-registry-index.ts`.
- **Lint** — `akm lint`. The rule set and finding shapes iterate; the
  `--fail-on-flagged` CI contract and the exit codes are stable.
- **Health** — `akm health` and its exit codes (0 pass / 4 warn / 1 fail) are
  Evolving; the *content* of the report (metrics, advisories) and the rendered
  `md` layout is Experimental — do not script against report layout.

## Experimental

Subject to change without notice within minor releases. Not yet recommended
for scripted use.

- **Local workspace API** — `akm-cli/workspace` exposes typed operations (assets,
  documents, proposals, bundles, config, feedback, env/secrets, activity), URL
  redaction and the error classes for a host process akm trusts: Desktop, or
  `akm-web`, which listens on loopback unless it is given `--host` (for example
  `0.0.0.0`). It is not a stable SDK: exports, signatures and result shapes may
  change in any release. Hosts own authentication and transport limits.
  See [Programmatic APIs](docs/reference/api.md#local-workspace-akm-cliworkspace).

- **Workflows** — the whole `akm workflow` surface (`run`, `status`, `list`,
  `create`, `resume`, `abandon`, `plan`), the workflow asset format and the
  workflow engine are Experimental from 0.9.28 and throughout 0.10. The 0.10
  series stabilizes the feature and trims what is not useful, then either
  promotes it out of Experimental or removes it if stabilization does not
  produce a quality feature. **Child workflows** (`unit: { workflow: … }`, a
  step that runs another workflow and returns its last step's output) are the
  least settled part and are kept only in that simple form; `akm workflow list
  --children` goes with them.

  Per-key status today. It stands until the promote-or-remove
  decision in [#1096](https://github.com/itlackey/akm/issues/1096); every key
  is still Experimental until then.

  | Key | Status |
  | --- | --- |
  | `params`, `steps`, `inputs`, `output` / `unit.output`, `defaults.connection` / `defaults.harness`, `### gate` | Core: the feature set pinned by `core-feature-set.test.ts` |
  | exec units (`unit.exec`), `budget`, `unit.retry`, `map`, `gate.max_loops` | Kept in the 0.10 trim |
  | child workflows (`unit.workflow`, `unit.with`) | Experimental: least settled |
- **`akm metrics`** — new in 0.9.28. What it reports, its JSON shape and the
  report layout may change in any release; do not script against them.
- **`lesson` asset type** — schema (`when_to_use`, `description`) is
  stable, but lesson-distillation triggers and ranking are tuning targets.
- **Protected env & secret values** — `env` (a whole `.env` group; key names
  are surfaced for discoverability, values never are) and `secret` (a single
  sensitive value). Values are never written to stdout, the index, or
  structured output; the safe injection path is `akm env run <name> --
  <command>` (or `akm secret run <name> <VAR> -- …`). The `env` / `secret`
  **write** verbs (`create`, `set`, `unset`, `remove`) are Experimental; the
  `list` / `path` / `run` / `export` read-and-inject surface is Stable.
- **Memory belief-state transitions** — `captureMode`, `beliefState`,
  contradiction edges, and the consolidate journal are observable, but the
  algorithm that writes them is tuning across patch releases.
- **Improve built-in strategies and lanes** — the built-in strategies other
  than `default` and `consolidate` and the proactive-maintenance lane. 0.10 measures each and keeps, folds or removes it
  (#1094). `quick`, `reflect-distill`, `thorough` and `catchup` were removed
  in 0.10 (#1130), as were `proactive-maintenance` and the high-salience lane (#1129); a user-defined strategy of the same name keeps working.
- **Improve tuning config** — `improve.strategies.*.processes.*` (limits,
  gates, and the CLS knobs), `improve.processes.*` and `improve.qualityGate`
  (where each process runs; `improve.*` is the base for all model work). The 0.9.x series is explicitly still settling
  the design of the improve processes, so **keys in these two families may be
  added, renamed, or dropped in any 0.9.x or 0.10.x release**. The `akm
  improve` *command* surface is Evolving (above); its tuning config is not.

### `akm improve` autonomy

`akm improve` is review-first by default. The command is on — its schedules and
reflect/distill proposals all run — but the lanes that change assets *without*
review require an explicit opt-in:

```sh
akm config set experimental.improveAutonomy true
```

An absent `experimental` section, an absent key and an explicit `false` all
read as off. Without the opt-in, these three lanes are downgraded (the triage lane only when its
judgment tier is on), and each downgrade is **reported,
not silent**: it warns on stderr naming the lane and the key, appends an
`improve_skipped` event with `reason: "autonomy_gated"`, is counted in
`akm health`'s improve skip-reason summary, and is listed by `akm info`
under `improveAutonomy.gatedLanes` — which is where to look when a *scheduled*
run stops doing something it used to. `akm info` also reports the
**effective** `improveTriage.applyMode`, so a `promote` strategy under a
review-first config correctly shows `queue`.

| Lane | What it does when enabled | With autonomy off |
| --- | --- | --- |
| `memoryInference` | Writes `.derived.md` children and rewrites parent frontmatter | disabled |
| memory cleanup | Belief-state frontmatter rewrites, archive moves | analyzed but not applied |
| `triage` `applyMode: "promote"` **with judgment on** | The judgment tier auto-accepts consolidate promotions into the bundle | downgraded to `queue` — triage still runs, it just does not auto-accept |

A deterministic-only `promote` (triage with judgment off) is **not** a gated
lane (#1143): the `default` strategy runs it without the opt-in, bounded by
`maxAcceptsPerRun` (200), through the same deterministic gates as
`akm proposal drain --promote`. Only a promote that turns the judgment tier on
needs `experimental.improveAutonomy`.

Consolidation remains enabled with autonomy off. Both passes emit proposals;
the pair pass stages a retirement when its claim checks pass and there is no
continuity risk. `triage` with `applyMode: "promote"` can accept that staged
retirement unattended; an unstaged retirement stays pending. Both retirement
checks receive complete note bodies with lexical attention hints, so the selected
model must accommodate them. The pair judge supplies distinct-claim lists; AKM
derives duplicate/subsumed/overlap outcomes and retirement direction from those
lists. Historical queued retirement labels remain readable. Before unattended drain after an upgrade, review pending/staged
retirements produced by older builds from notes over 12,000 body characters:
upgrading does not revalidate their evidence (#1195).

Because the gate is applied before the LLM preflight, a review-first workspace
also needs fewer connections or harnesses configured: a strategy whose only
model-backed process is a gated lane resolves without one at all.

Reflect, distill, extract candidates, validation and proactive-maintenance
selection only stage proposals. These writes are not gated by the opt-in:

| Write | What it does |
| --- | --- |
| `extract` session indexing | Writes `sessions/**` assets (`processes.extract.indexSessions`, default on) |
| distill's encoding-salience stamp | Writes a salience score to asset frontmatter |
| Graced archive purge | At the start of every improve run, removes retirement archives past the grace period |
| Accept commits | Accepting a proposal commits its paths when the bundle is a git repository |
| `sync.push` | Pushes already-committed content to the configured remote; turn it off with `improve.strategies.<name>.sync.push: false` or `--no-push` |

## Internal

Not public interfaces. Listed so you can recognize them, not so you can rely
on them.

- **Migration surfaces** — the standalone migrator (`status`,
  `apply`) rewrites config, pending `state.db` migrations, asset `engine:` keys
  and old ref spellings to the current shape, taking a backup first. `akm migrate` is a thin process
  forwarder for it.
- **`bun scripts/build-registry-index.ts`** — maintainer tooling for building a
  registry index. It is a repository script, not a CLI command.
- **Environment variables** — see the table below.

### Environment variables

**Supported** — documented interfaces; changes get a CHANGELOG note:

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_FILE` (and the global `--config <file>`) | The config file this run uses; its `paths` key (`data`, `state`, `cache`) places the rest |
| `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`, `AKM_CACHE_DIR` | **Retired** (0.11): replaced by `AKM_CONFIG_FILE` and `paths`. Set without `AKM_CONFIG_FILE`, akm exits 78 (`RETIRED_LOCATION_VARIABLE`) naming `akm migrate apply` and `AKM_CONFIG_FILE`; `akm migrate`, `akm upgrade`, `akm info`, `--version` and `--help` still run. |
| `AKM_BUNDLE_DIR` | **Retired** (0.11): the working bundle is `defaultBundle` (or `--bundle`). Naming the directory of the bundle akm resolves without it, or set with `AKM_CONFIG_FILE`, it is ignored; naming any other directory, akm exits 78 (`RETIRED_LOCATION_VARIABLE`) naming `akm migrate apply` (which registers that directory as `defaultBundle`). |
| `AKM_NPM_REGISTRY` | npm mirror base URL; replaces `registry.npmjs.org` for package lookups |
| `AKM_INSTALL_DIR` | Install-script prefix (read by `install.sh` and `install.ps1`, not by akm itself) |

**Internal** — no compatibility guarantee, may vanish without notice:
`AKM_NODE_ENTRY`, `AKM_STANDALONE_ENTRY`, `AKM_MIGRATE_ENTRY`,
`AKM_LAUNCHER_PID`, `AKM_LAUNCHER_NODE`, `AKM_LAUNCHER_PATH`,
and the eight handed to a workflow unit's script
(`AKM_RUN_ID`, `AKM_STEP_ID`, `AKM_UNIT_ID`, `AKM_PARAMS`, `AKM_ITEM`,
`AKM_ITEM_INDEX`, `AKM_INPUTS`, `AKM_TASK_INPUTS`).

Internal seam used by akm-eval and the tests, never for product use:
`AKM_EMBED_DETERMINISTIC` (a hash embedder instead of a model).

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
- [`SECURITY.md`](./SECURITY.md) — supported versions and how to report a
  vulnerability.
- [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md) — the
  normative ref grammar.
- [`docs/reference/data-and-telemetry.md`](./docs/reference/data-and-telemetry.md) — what
  state akm reads and writes locally.
