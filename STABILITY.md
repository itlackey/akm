# Stability policy

`akm-cli` follows [Semantic Versioning](https://semver.org/) on the 0.x line
**with one caveat**: while the version is 0.x, minor releases (0.x → 0.x+1)
may include breaking changes.

**0.9.x series exception.** The 0.9.x releases are a deliberate refactoring
and clean-up series: the goal is to pay off all remaining technical debt and
land every planned breaking change before 0.10. While that work completes,
**0.9.x patch releases may also contain breaking changes** — each one called
out in the CHANGELOG with a migration note. The 0.10.x series returns to bug
fixes and tuning, and aims to restore the normal discipline of breaking
changes only in major and minor releases.

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

## Command tier index

The canonical index: every command and subcommand group in the current tree
(enumerated from `main.subCommands` in `src/cli.ts` and each group's own
`subCommands`), with its tier. The sections below explain what each tier
covers beyond the table.

| Command | Tier | Notes |
| --- | --- | --- |
| `akm setup` | Stable | |
| `akm index` | Stable | |
| `akm health` | Evolving | Exit codes (0 pass, 4 warn, 1 fail) are Evolving; report *content* and rendered `md`/`html` layout are Experimental — do not script against report layout. |
| `akm metrics` | Experimental | Report content, JSON shape and the `html` dashboard may change. |
| `akm info` | Stable | |
| `akm bundle create` | Stable | |
| `akm bundle add` | Stable | |
| `akm bundle list` | Stable | |
| `akm bundle show` | Evolving | |
| `akm bundle rename` | Stable | |
| `akm bundle remove` | Stable | |
| `akm bundle update` | Stable | |
| `akm upgrade` | Stable | Including the plugin step and `--next`. |
| `akm search` | Stable | |
| `akm curate` | Stable | |
| `akm show` | Stable | |
| `akm workflow status` | Experimental | `--all-scopes` is additive. |
| `akm workflow plan` | Experimental | Zero-write introspection of a workflow's frozen plan; envelope shape may change. |
| `akm workflow list` | Experimental | `--all-scopes` and a top-level `scopeKey` envelope field are additive. |
| `akm workflow create` | Experimental | |
| `akm workflow resume` | Experimental | |
| `akm workflow abandon` | Experimental | |
| `akm workflow run` | Experimental | Canonical start/resume/execute command. |
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
| `akm config diff` | Evolving | Compares effective (post-`extends`) configs. |
| `akm feedback` | Stable | |
| `akm log` | Evolving | |
| `akm agent` | Evolving | |
| `akm command run` | Evolving | Runs stored command templates through the same agent dispatch as `akm agent`. |
| `akm models list` | Evolving | Model intent aliases and their defaults. |
| `akm models copy-defaults` | Evolving | Copies the installed `models.json` into the user configuration directory. |
| `akm lint` | Evolving | |
| `akm improve` | Evolving | Review-first by default; mutating lanes require `experimental.improveAutonomy` — see below. |
| `akm proposal list` | Stable | |
| `akm proposal show` | Evolving | |
| `akm proposal diff` | Evolving | |
| `akm proposal accept` | Evolving | |
| `akm proposal reject` | Evolving | |
| `akm proposal reopen` | Evolving | Undoes a rejection. |
| `akm proposal revert` | Evolving | |
| `akm proposal drain` | Evolving | |
| `akm proposal extract` | Experimental | Session extraction quality is still being measured. |
| `akm proposal new` | Evolving | |
| `akm help` | Stable | |
| `akm help agents` | Stable | |
| `akm help migrate` | Stable | Only renders release notes. |
| `akm hints` | Stable | Format-exempt agent guide; `--detail brief` selects the compact version. |
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
| `akm task add` | Evolving | |
| `akm task enable` | Evolving | |
| `akm task disable` | Evolving | |
| `akm task run` | Evolving | |
| `akm task history` | Evolving | |
| `akm task sync` | Evolving | |
| `akm task prune` | Evolving | |
| `akm task doctor` | Evolving | |
| `akm task explain` | Evolving | Zero-write: shows what a task would do without starting a run. |
| `akm task validate` | Evolving | Zero-write, and the only `task` subcommand that takes a bare filesystem path instead of a ref — the file need not belong to any configured bundle. |
| `akm task list` | Evolving | A delegating alias for `akm search --type task` — same envelope, no separate implementation. |

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
  short form is accepted as input only. The `<type>:<name>` grammar is not
  accepted.
  - `#fragment` is **input-only** and never stored, and only `akm show`
    accepts it. On markdown-document items the core resolves it as a section
    selector — `akm show <ref>#<heading-slug>` returns that one section, no
    fragment returns the whole item, and an unmatched fragment lists the
    available slugs. On any other item `akm show` ignores the fragment, warns,
    and shows the whole item. See
    [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md).
  - **Refs in prose** must be fully qualified (`bundle//conceptId`) or a native
    adapter link form. A bare conceptId in prose is ordinary text, not a ref.
- **ConceptId-prefix enumeration** — `akm search "memories/"`,
  `"memories/projecta/"`, `"bundle//"`, `"bundle//skills/"`. A trailing `/` is
  required. The prefix matches the **conceptId** — the spelling every emitted
  `ref` carries — so a ref copied out of search output can be truncated to a
  prefix and pasted back in. Enumeration is not tied to any adapter's type set,
  so every adapter's items browse the same way, and `bundle//` lists a whole
  bundle. A prefix is explicit intent, so `search.defaultExcludeTypes` does not
  apply to it. A `"<type>:"` query is an ordinary keyword search whose
  empty-result tip names the conceptId spelling that replaces it.
- **Renames are delete + create** — moving or renaming an item gives it a new
  identity; learned state (feedback, usage, salience) does not follow it.
  Cross-bundle movement is copy/import plus delete. Move the file, then run
  `akm index`, then `akm lint` to catch inbound refs the move left dangling.
  There is no `akm mv`; `scripts/rekey-asset-ref.ts` re-keys earned signal from
  an old ref to a new one and is Internal tooling.
- **Asset `type` is a free-form, open string** — `--type` filtering is an
  exact match against an open set and is not validated: an unrecognized type
  returns zero hits, not an error. Adapters emit types outside the built-in
  set, so `--type website` or `--type wiki-source` are ordinary, valid filters.
- **Output contracts** — JSON output shape (the top-level keys), the error
  envelope, and the exit codes below.
  - Failures print `{ok: false, error, code?, hint?}` to stderr. `ok` and
    `error` are always present; `code` is a stable machine-readable identifier
    on every classified failure (exit 1, 2, 75 and 78) and absent on
    unexpected internal errors (exit 70); `hint` is best-effort. Prefer `code`
    over matching `error` prose. Success envelopes from the passthrough stamp
    (`config`, `clone`, `models`, `task-*`, `workflow-*`, `registry-*`, …) also
    carry `ok: true`; a command that computes its own `ok` keeps it.
  - All six `--format` values (`json|jsonl|yaml|text|md|html`) are available on
    every non-exempt command. `json`, `jsonl` and `yaml` serialize the
    envelope; `text`, `md` and `html` render it. A command may register a
    bespoke renderer for a document format (`akm health` does); anything
    unregistered falls back to a generic rendering derived from the envelope's
    shape. No command reads `--format` to decide what data to fetch.
  - `--detail` is verbosity only (`brief|normal|full`); `--shape`
    (`human|agent|summary`) is the output-projection axis (see Experimental).
  - **Format-exempt** commands do not emit a result envelope: `completions`
    (shell script source), `help` (bare, `help agents`, `help migrate`),
    `hints`, `env run` / `secret run` (child-process passthrough) and
    `env path` (a bare path). The set is declared in
    `src/output/format-exempt.ts`, and passing `--format` to one of them warns.
    Scripted `setup` modes emit a normal format-aware result; interactive
    `setup` is a terminal UI. `migrate status` and `migrate apply` are not
    exempt: they render the child tool's result through the normal pipeline,
    and any progress lines the child prints during `apply` appear verbatim
    ahead of it.

  | Exit code | Meaning |
  | --- | --- |
  | `0` | Success |
  | `1` | Not found / command-reported failure |
  | `2` | Usage / bad input |
  | `4` | Health warning (`akm health` only) |
  | `70` | Internal / unclassified |
  | `75` | Transient — retry shortly (`TransientError`, sysexits `EX_TEMPFAIL`); another akm process holds a lock or is writing `state.db` or `index.db` right now |
  | `78` | Configuration error |

- **Install scripts** — the `install.sh` and `install.ps1` URLs and the
  `AKM_INSTALL_DIR` environment override.
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

- **Improvement loop** — `akm improve` and the `akm proposal` group. Output
  JSON keys are stable; CLI flags (for example `--strategy`, `--task`) may add
  options or tighten validation across releases. `akm improve` is on by
  default and **review-first**: the lanes that change assets without review
  require `experimental.improveAutonomy` — see
  [`akm improve` autonomy](#akm-improve-autonomy). `--auto-accept` is accepted,
  warned about and ignored (a following value such as `--auto-accept 90` is
  discarded with a second warning); it becomes a hard error in 0.10. The
  replacement is `akm improve && akm proposal drain --promote --yes`, or a
  `triage` block with `applyMode: "promote"` in your strategy.
- **Tasks** — `akm task` subcommands and flags may shift. Task source v4 YAML
  (typed `inputs:`, optional `schedule:`) is the only accepted version; task v2
  and v3 sources are converted by `akm migrate apply`. Command tasks use named
  engines and task history metadata is versioned. Schema additions arrive in
  patch releases; removals only at minor. Bare `akm task` is a usage error
  naming the subcommands, and `akm task doctor` reports scheduler diagnostics.
  `akm task explain <ref>`, `akm task validate <path>` and
  `akm workflow plan <ref>` are zero-write: they show what a task or workflow
  would do — resolved target, input bindings, child expansion — or whether a
  file would parse, without starting or publishing a run. `akm task validate`
  reports `valid`, `blocked` (needs `akm migrate apply` first: task v2/v3, or
  a retired `schedule[].enabled`), `invalid`, or `not-a-task`.
- **Bundles & the workspace model** — installed sources are *bundles*; each is
  recognized by a built-in *adapter* (native Agent Skills, Claude and OpenCode
  commands/agents, knowledge, YAML workflows, tasks, env/secret files, scripts,
  OKF and LLM-wiki knowledge bases). Config is keyed by `bundles` and
  `defaultBundle`. The adapter set, bundle-recognition rules, and the
  `bundles` config shape may still shift; the `okf`, `llm-wiki` and
  `generic-files` adapters in particular are Evolving. Bundles are inspected
  through `akm bundle list` / `akm bundle show <name>` and enumerated through
  `akm search "bundle//"`. OKF is the baseline for Markdown concept identity
  and generic reads; AKM-authored Markdown is an OKF-compatible superset whose
  adapter adds native behavior progressively.
- **LLM Wiki bundles** — the `llm-wiki` adapter owns `schema.md` / `index.md` /
  `log.md` / `raw/` / `pages/` and its ingest flow; wiki pages are addressed as
  ordinary concepts inside their bundle. Adapter behavior and page conventions
  are still iterating.
- **Agent dispatch** — `akm agent` and `akm command run`. Supported harnesses:
  `claude`, `opencode-sdk` (the primary OpenCode interface), `opencode` (the
  CLI path, a deprecation candidate once `opencode-sdk` covers it), `codex`,
  `copilot`, `pi`, `gemini`, `aider`, `amazonq` and `openhands`. Every harness
  is Evolving: the harness implementation is being reworked so harnesses are
  easy to add, remove and update (0.10).
- **Proposal queue** — proposal statuses (`pending`, `accepted`, `rejected`,
  `reverted`) are stable; the JSON shape of a proposal record may add fields.
- **Registries** — registries are searched with `akm search --from registry`.
  Building a registry index is maintainer tooling (Internal) and lives outside
  the CLI, in `scripts/build-registry-index.ts`.
- **Upgrade** — `akm upgrade` is Stable (see the table). The recovery hatch for
  a broken upgrade checksum is the `AKM_UPGRADE_SKIP_CHECKSUM` environment
  variable (Internal), not a flag.
- **Lint** — the rule set and finding shapes iterate; the `--fail-on-flagged`
  CI contract and the exit codes are stable.

## Experimental

Subject to change without notice within minor releases. Not yet recommended
for scripted use.

- **Workflows** — the whole `akm workflow` surface (`run`, `status`, `list`,
  `create`, `resume`, `abandon`, `plan`), the workflow asset format and the
  workflow engine are Experimental through 0.10. The 0.10 series
  stabilizes the feature and trims what is not useful, then either promotes it
  out of Experimental or removes it if stabilization does not produce a quality
  feature.
- **`lesson` asset type** — the schema (`when_to_use`, `description`) is
  stable, but lesson-distillation triggers and ranking are tuning targets.
- **`--shape agent` and `--shape summary`** — the output-projection axis.
  `summary` is implemented only on `akm show`; `agent` is implemented on
  `search`, `show` and `curate`.
- **Env and secret write verbs** — `env create`, `env remove` and
  `secret set`. The read-and-inject commands are Stable: `akm env list`,
  `akm secret list` and `akm show` print names only, and
  `akm env run <name> -- <command>` and `akm secret run <name> <VAR> -- <command>`
  pass values to the child process.
- **Memory belief-state transitions** — `captureMode`, `beliefState`,
  contradiction edges, and the consolidate journal are observable, but the
  algorithm that writes them is tuning across patch releases.
- **Improve built-in strategies and lanes** — the built-in strategies other
  than `default` and `consolidate` (`quick`, `reflect-distill`, `thorough`,
  `catchup`) and the proactive-maintenance and high-salience lanes. 0.10
  measures each and keeps, folds or removes it.
- **Session extraction** — `akm proposal extract` and the `extract` process:
  what it extracts, its quality gates and its output may change while 0.10
  measures it.
- **Improve tuning config** — `improve.strategies.*.processes.*` (per-process
  engines, limits, gates, and the anti-collapse / CLS / fidelity knobs) and
  the `index.*` per-pass config. The 0.9.x series is still settling the design
  of the improve processes, so **keys in these two families may be added,
  renamed, or dropped in any 0.9.x or 0.10.x release**. The `akm improve`
  *command* surface is Evolving; its tuning config is not.

### `akm improve` autonomy

`akm improve` is review-first by default. The command is on — its schedules and
reflect/distill proposals all run — but the lanes that change assets *without*
review require an explicit opt-in:

```sh
akm config set experimental.improveAutonomy true
```

An absent `experimental` section, an absent key and an explicit `false` all
read as off. Without the opt-in, these three lanes are downgraded, and each
downgrade is reported: a warning on stderr names the lane and the key, an
`improve_skipped` event with `reason: "autonomy_gated"` is appended, `akm
health` counts it in its improve skip-reason summary, and `akm task doctor`
lists it under `improveAutonomy.gatedLanes` — which is where to look when a
*scheduled* run stops doing something it used to. `akm task doctor` also
reports the **effective** `improveTriage.applyMode`, so a `promote` strategy
under a review-first config shows `queue`.

| Lane | What it does when enabled | With autonomy off |
| --- | --- | --- |
| `memoryInference` | Writes `.derived.md` children and rewrites parent frontmatter | disabled |
| memory cleanup | Belief-state frontmatter rewrites, archive moves | analyzed but not applied |
| `triage` `applyMode: "promote"` | Auto-accepts queued proposals into the bundle | downgraded to `queue` — triage still runs, it just does not auto-accept |

Consolidation stays enabled with autonomy off: both of its passes (promotion,
and the pair pass's duplicate/subsumed/supersedes judging) only emit
reviewable proposals. With autonomy on and `triage` `applyMode: "promote"`, the
drain accepts the proposals the judge passed, and accepts a pair-pass `retire`
proposal only when the pair pass itself staged it with no continuity risk;
every other `retire` proposal waits for `akm proposal accept`.

Because the gate is applied before the LLM preflight, a review-first workspace
also needs fewer engines configured: a strategy whose only model-backed process
is a gated lane resolves without an engine at all.

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

- **Migration surfaces** — the standalone `akm-migrate` tool (`status`,
  `apply`) rewrites config, `state.db`, task files and old on-disk residue to
  the current shape, taking a backup first. `akm migrate` is a thin process
  forwarder for it.
- **`bun scripts/build-registry-index.ts`** — maintainer tooling for building a
  registry index. It is a repository script, not a CLI command.
- **Environment variables** — see the table below.

### Environment variables

**Supported** — documented interfaces; changes get a CHANGELOG note:

| Variable | Purpose |
| --- | --- |
| `AKM_BUNDLE_DIR`, `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_CACHE_DIR` | Filesystem layout overrides |
| `AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`, `AKM_ENGINE_<NAME>_API_KEY` | Credential provision for `$VAR` config references |
| `AKM_LLM_ENDPOINT`, `AKM_LLM_BASE_URL` | Setup provider inference |
| `AKM_VERBOSE`, `AKM_DEBUG` | Diagnostics |
| `AKM_REGISTRY_URL` | Comma-separated registry URL override; replaces the configured registries |
| `AKM_NPM_REGISTRY` | npm mirror base URL; replaces `registry.npmjs.org` for package lookups |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode (network filesystems) |
| `AKM_INSTALL_DIR` | Install-script prefix |
| `AKM_UPGRADE_SKIP_CHECKSUM` | Recovery hatch for a broken upgrade checksum |

**Internal** — no compatibility guarantee, may vanish without notice:
`AKM_NODE_ENTRY`, `AKM_EVENT_SOURCE`, `AKM_SESSION_ID`, `AKM_AGENT_HARNESS`,
`AKM_EMBED_DETERMINISTIC`, `AKM_CLAUDE_PROJECTS_DIR`,
`AKM_FORCE_INIT_TMP_STASH`, `AKM_STATE_DIR`.

## On the horizon

These changes are planned and will land in a known future release. They
are not part of the current stability contract; you should plan migrations
around them.

- **0.10 — `config set`/`config unset` may drop the config dump** in favor of
  a compact `{ok, shape, key}` result; `akm config list` remains the full read.
- **0.10 — migration extraction.** The migration machinery leaves the CLI for
  a separately published `akm-migrate` package (see Internal above).
- **0.10 — `--auto-accept` hard error.** It is currently accepted-and-warned;
  see the Improvement loop entry.

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
