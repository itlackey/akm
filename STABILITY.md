# Stability policy

`akm-cli` follows [Semantic Versioning](https://semver.org/) on the 0.x line
**with one caveat**: until 1.0, minor releases (0.x → 0.x+1) may include
breaking changes.

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
| **Experimental** | Subject to change without notice. Not recommended for scripted use. Some experimental surfaces additionally require an explicit opt-in — see [`akm improve` autonomy](#akm-improve-autonomy--opt-in-in-090). |
| **Internal** | Not a public interface. May change or disappear in any release, without a CHANGELOG note. Listed here only so you can recognize it. |

## Command tier index

The canonical index: every command and subcommand group in the current tree
(enumerated from `main.subCommands` in `src/cli.ts` and each group's own
`subCommands`), with its tier. The prose sections below remain the detailed
explanation of *why*; this table is the lookup. Two spots have no single
explicit sentence naming their tier and were resolved by reading neighbors:
`akm bundle show` is assigned Evolving because it is discussed only inside
the Evolving "Bundles & the workspace model" bullet, alongside the still-
shifting adapter set, unlike its sibling `akm bundle list`, which the Stable
section names explicitly; and `akm proposal list` is assigned Stable — the
Stable section names it explicitly ("list filters"), which takes precedence
over its incidental mention inside the Evolving "Improvement loop" bullet's
enumeration of the whole `proposal` noun group.

| Command | Tier | Notes |
| --- | --- | --- |
| `akm setup` | Stable | |
| `akm index` | Stable | |
| `akm health` | Evolving | Exit codes are Evolving; report *content* and rendered `md`/`html` layout are Experimental — do not script against report layout. |
| `akm info` | Stable | |
| `akm bundle create` | Stable | |
| `akm bundle add` | Stable | |
| `akm bundle list` | Stable | |
| `akm bundle show` | Evolving | See note above. |
| `akm bundle remove` | Stable | |
| `akm bundle update` | Stable | |
| `akm upgrade` | Evolving | |
| `akm search` | Stable | |
| `akm curate` | Stable | |
| `akm show` | Stable | |
| `akm workflow status` | Stable | `--all-scopes` added in 0.9.15 (#942), additive. |
| `akm workflow plan` | Evolving | New in 0.9.2; secret-free provenance output; envelope shape may change. |
| `akm workflow list` | Stable | `--all-scopes` and a top-level `scopeKey` envelope field added in 0.9.15 (#942), both additive. |
| `akm workflow create` | Stable | |
| `akm workflow resume` | Stable | |
| `akm workflow abandon` | Stable | |
| `akm workflow run` | Stable | Canonical start/resume/execute command. |
| `akm remember` | Stable | |
| `akm import` | Stable | |
| `akm sync` | Stable | |
| `akm clone` | Stable | |
| `akm registry list` | Evolving | |
| `akm registry add` | Evolving | |
| `akm registry remove` | Evolving | |
| `akm migrate status` | Internal | Forwards to the standalone `akm-migrate` tool; renders its result through the normal `--format` pipeline (not exempt — see below). Listed (not hidden) in `--help`/completions. |
| `akm migrate apply` | Internal | Forwards to the standalone `akm-migrate` tool; renders its result through the normal `--format` pipeline (not exempt — see below). Listed (not hidden) in `--help`/completions. |
| `akm config path` | Stable | |
| `akm config list` | Stable | |
| `akm config get` | Stable | Default bare-value shape unchanged; `--show-source` (0.9.15, opt-in) wraps it as `{ value, source }`. |
| `akm config set` | Stable | |
| `akm config unset` | Stable | |
| `akm config diff` | Evolving | New in 0.9.15; compares effective (post-`extends`) configs, secrets redacted. |
| `akm feedback` | Stable | |
| `akm log` | Evolving | |
| `akm agent` | Evolving | |
| `akm lint` | Evolving | |
| `akm improve` | Evolving | Review-first by default; mutating lanes require `experimental.improveAutonomy` — see below. |
| `akm proposal list` | Stable | See reconciliation note above. |
| `akm proposal show` | Evolving | |
| `akm proposal diff` | Evolving | |
| `akm proposal accept` | Evolving | |
| `akm proposal reject` | Evolving | |
| `akm proposal revert` | Evolving | |
| `akm proposal drain` | Evolving | |
| `akm proposal extract` | Evolving | Former top-level `akm extract`. |
| `akm proposal new` | Evolving | Former top-level `akm propose`. |
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
| `akm task run` | Evolving | |
| `akm task history` | Evolving | |
| `akm task sync` | Evolving | |
| `akm task doctor` | Evolving | |
| `akm task explain` | Evolving | New in 0.9.2; secret-shaped values in provenance output are redacted on a best-effort heuristic basis (not a guarantee). |
| `akm task validate` | Evolving | New in 0.9.11; read-only, and the only `task` subcommand that takes a bare filesystem path instead of a ref — the file need not belong to any configured bundle. |
| `akm task list` | Evolving | New in 0.9.15 (#951); a pure delegating alias for `akm search --type task` — same envelope, no separate implementation. |

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
    unmatched fragment lists the available slugs. Elsewhere it is an
    adapter-owned selector opaque to the core. See
    [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md).
  - **Refs in prose** must be fully qualified (`bundle//conceptId`) or a native
    adapter link form. A bare conceptId in prose is ordinary text, not a ref,
    and no akm tool rewrites it.
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
  `akm help`, `akm help agents`, `akm hints`, `akm completions`.
- **Write commands core surface** — `akm bundle add`, `akm bundle update`,
  `akm bundle remove`, `akm clone`, `akm import`, `akm sync`, `akm index`,
  `akm bundle create`, `akm setup`, `akm remember`, `akm feedback`,
  `akm config set`, `akm config unset`.
- **Renames are delete + create** — moving or renaming an item gives it a new
  identity; learned state does not follow it. Cross-bundle movement is
  copy/import plus delete. The procedure is a plain filesystem move, then
  `akm index`, then `akm lint` to catch inbound refs the move left dangling.
  `akm mv` was **removed in 0.9.0**: it claimed to preserve identity across a
  rename, but its inbound-ref rewriting targeted bare conceptIds rather than
  the anchored `bundle//conceptId` prose form, so it could rewrite non-refs
  while leaving real refs dangling. To carry an asset's earned signal
  (feedback, usage, salience/outcome history) across a rename, the maintainer
  script `scripts/rekey-asset-ref.ts` re-keys those rows old -> new; it is
  Internal tooling, not a supported command surface.
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
  **All six** `--format` values (`json|jsonl|yaml|text|md|html`) are available
  on every non-exempt command. `json`, `jsonl`, and `yaml` serialize the
  envelope; `text`, `md`, and `html` render it. A command may register a bespoke
  renderer for a document format — `akm health` does, for its per-run and
  window-compare tables and its full HTML report — and anything unregistered
  falls back to a generic rendering derived from the envelope's own shape. No
  command emits one format's bytes when another was asked for, none rejects a
  format outright, and **no command reads `--format` to decide what data to
  fetch**: a registered renderer fires on the shape of the result (`akm health
  --report` carries the report dataset in the envelope, so the same data is
  available as JSON), never on the format alone.
  `--detail` is verbosity only (`brief|normal|full`);
  `--shape` (`human|agent|summary`) is the output-projection axis (see
  Experimental). A small set of commands is **format-exempt** because their
  output is not a result envelope at all: `completions` (shell script source),
  child-process passthrough in `env run` / `secret run`, a bare-path payload
  from `env path`, and document payloads from `help` (bare, `help agents`, and
  `help migrate`). The set is declared in
  `src/output/format-exempt.ts`, and
  passing `--format` to one of them warns rather than silently doing something
  else. Scripted `setup` modes emit a normal format-aware result; interactive
  `setup` is a terminal UI and emits no result document. `agent` leaves
  inherited child streams raw and formats its final result envelope.
  `migrate status`/`apply` both spawn the standalone `akm-migrate` tool but are
  NOT in the exempt set: `src/commands/migrate-cli.ts` parses the child's
  final JSON result line and renders it through the same `output()` pipeline
  (registered shape `src/output/shapes/migrate.ts`, text renderer
  `src/output/text/migrate.ts`), so all six `--format` values work on them
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
  | `75` | Transient — retry shortly (`TransientError`, sysexits `EX_TEMPFAIL`); another akm process holds a lock or is writing `state.db` right now |
  | `78` | Configuration error |

  **From 0.9.12**, every success envelope produced by the passthrough stamp
  (`config`, `clone`, `models`, `task-*`, `workflow-*`, `registry-*`, …) also
  carries `ok: true`; a command that already computes its own `ok` keeps it.
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

- **Improvement loop** — `akm improve` and the proposal noun group
  `akm proposal {extract,new,list,show,diff,accept,reject,revert,drain}`
  (`extract` and `new` are the former top-level `akm extract`/`akm propose`,
  moved under `proposal` in 0.9.0). Output JSON keys
  are stable; CLI flags (`--strategy`, `--task`, `--generator`) may add
  options or tighten validation across releases. `akm improve` stays on by
  default and is **review-first**: the lanes that mutate assets without review
  require `experimental.improveAutonomy` — see
  [`akm improve` autonomy](#akm-improve-autonomy--opt-in-in-090).
  `--auto-accept` was removed in 0.9.0. It is now accepted-and-warned rather
  than silently absorbed: passing it prints a deprecation warning naming the
  replacement, and the space-separated form (`--auto-accept 90`) no longer
  poisons the asset-type positional — its value is discarded with a second
  warning instead of silently reducing the run to a zero-match no-op. It
  becomes a hard error in 0.10. The replacement is
  `akm improve && akm proposal drain --promote --yes`, or a `triage` block
  with `applyMode: "promote"` in your strategy.
- **Tasks** — `akm task` subcommand surface (`add | run | sync | doctor |
  history | explain | validate`; no alias, no
  `list`/`remove`/`init`/`enable`/`disable`); task source v4 YAML (typed
  `inputs:`, optional `schedule:`) is the only accepted version — task v3 and
  task v2 sources are converted by `akm migrate apply`. Command tasks use
  named engines and task history metadata is versioned. Schema additions in
  patch releases; removals only at minor. Bare `akm task` is a usage error
  naming the subcommands (`akm task doctor` reports scheduler diagnostics).
  `akm task explain <ref>` (new in 0.9.2) and `akm workflow plan <ref>` are
  both zero-write provenance surfaces: they show what a task or workflow
  would do — resolved target, input bindings, child expansion — without
  starting or publishing a run. `akm workflow plan` is secret-free **by
  construction** (the excluded data never reaches the command). `akm task
  explain` instead **redacts** secret-shaped input values on a best-effort
  heuristic basis — a value that doesn't match the heuristic can still
  print unredacted. `akm task validate <path>` (new in 0.9.11) is the same
  kind of zero-write introspection as `explain`, but takes a bare filesystem
  path rather than a bundle-qualified ref — it reports whether that ONE file
  would parse cleanly (`valid`), auto-convert from task v2/v3 (`converts`),
  need a human decision the deterministic migrator can't make (`blocked`),
  fail schema validation (`invalid`), or isn't a task source at all
  (`not-a-task`) — exactly the diagnostic `akm task sync` would produce for
  it, before the file is ever wired into a bundle or the scheduler.
- **Workflow plan** — `akm workflow plan <ref>`, new in 0.9.2: zero-write
  compile+freeze introspection (the canonical step graph, task/child
  expansion, input bindings, and lowering notices for a workflow, without
  starting or publishing a run). The envelope shape may still change; the
  five long-Stable `workflow` verbs (`status`, `list`, `create`, `resume`,
  `abandon`) and `run` are unaffected.
- **Events / log** — `akm log` is the event-stream surface (0.9.0: the
  asset-scoped `akm history` surface, and `log`'s own `tail` subcommand, were
  both removed; `log` is now a leaf command — the former `list` surface).
- **Bundles & the workspace model** — installed sources are *bundles*; each is
  recognized by a built-in *adapter* (native Agent Skills, Claude and OpenCode
  commands/agents, knowledge, YAML workflows, tasks, env/secret files, scripts,
  OKF and LLM-wiki knowledge bases). Config is keyed by `bundles` and
  `defaultBundle`. The adapter set, bundle-recognition rules, and the
  `bundles` config shape may still shift. Bundles are inspected through
  `akm bundle list` / `akm bundle show <name>` and enumerated through
  `akm search "bundle//"`. (An earlier `akm bundle items` noun group was
  removed in 0.9.0 as duplicative of `akm search`; the current `akm bundle`
  group — `create | add | list | show | remove | update` — is the
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
- **Agent dispatch** — `akm agent` subcommand. Supported backends: `claude`,
  `opencode`, `opencode-sdk`, `codex`, `copilot`, `pi`, `gemini`, `aider`,
  `amazonq`, `openhands`. The set will grow.
- **Proposal queue** — quality classifications (`accepted`, `pending`,
  `proposed`, `rejected`, `archived`) are stable; the JSON shape of a
  proposal record may add fields.
- **Registries** — `akm registry {list,add,remove}`. Searching registries is
  `akm search --from registry` (0.9.0: `registry search` was folded into
  `search`). Building a registry index is maintainer tooling (Internal) and
  lives outside the CLI, in `scripts/build-registry-index.ts`.
- **Upgrade** — `akm upgrade`. Checksum verification is not optional; the
  recovery hatch is the `AKM_UPGRADE_SKIP_CHECKSUM` environment variable
  (Internal), not a flag.
- **Lint** — `akm lint`. The rule set and finding shapes iterate; the
  `--fail-on-flagged` CI contract and the exit codes are stable.
- **Health** — `akm health` and its exit codes (0 pass / 4 warn / 1 fail) are
  Evolving; the *content* of the report (metrics, advisories) and the rendered
  `md` / `html` layouts are Experimental — do not script against report layout.

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
  <command>` (or `akm secret run <name> <VAR> -- …`). The `env` / `secret`
  **write** verbs (`create`, `set`, `unset`, `remove`) are Experimental; the
  `list` / `path` / `run` / `export` read-and-inject surface is Stable.
- **Memory belief-state transitions** — `captureMode`, `beliefState`,
  contradiction edges, and the consolidate journal are observable but
  the algorithm that writes them is tuning across patch releases.
- **Improve tuning config** — `improve.strategies.*.processes.*` (per-process
  engines, limits, gates, and the anti-collapse / CLS / fidelity knobs) and
  the `index.*` per-pass config. The 0.9.x series is explicitly still settling
  the design of the improve processes, so **keys in these two families may be
  added, renamed, or dropped in any 0.9.x or 0.10.x release**. The `akm
  improve` *command* surface is Evolving (above); its tuning config is not.

### `akm improve` autonomy — opt-in in 0.9.0

**`akm improve` is review-first by default in 0.9.0.** The command itself is ON
— its schedules, reflect/distill proposals, and graph extraction all run — but
the lanes that mutate assets *without* review require an explicit opt-in:

```sh
akm config set experimental.improveAutonomy true
```

Without it, these three lanes are downgraded, and each downgrade is **reported,
not silent**: it warns on stderr naming the lane and the key, appends an
`improve_skipped` event with `reason: "autonomy_gated"`, is counted in
`akm health`'s improve skip-reason summary, and is listed by `akm task doctor`
under `improveAutonomy.gatedLanes` — which is where to look when a *scheduled*
run stops doing something it used to. `akm task doctor` also reports the
**effective** `improveTriage.applyMode`, so a `promote` strategy under a
review-first config correctly shows `queue`.

| Lane | What it does when enabled | With autonomy off |
| --- | --- | --- |
| `memoryInference` | Writes `.derived.md` children and rewrites parent frontmatter | disabled |
| memory cleanup | Belief-state frontmatter rewrites, archive moves | analyzed but not applied |
| `triage` `applyMode: "promote"` | Auto-accepts queued proposals into the bundle | downgraded to `queue` — triage still runs, it just does not auto-accept |

Consolidation remains enabled with autonomy off because merge, delete, and
contradiction operations are advisory; promotion only emits a reviewable
proposal.

Because the gate is applied before the LLM preflight, a review-first workspace
also needs fewer engines configured: a strategy whose only model-backed process
is a gated lane resolves without an engine at all.

**Three direct writes are deliberately NOT gated**, because they are additive or
already independently controlled:

| Write | Why it stays ungated |
| --- | --- |
| `extract` session indexing | Additive `sessions/**` writes; nothing is overwritten or deleted |
| distill's encoding-salience stamp | Frontmatter metadata only |
| `sync.push` | Publishes already-committed content to a remote the user configured for that purpose, and has its own `improve.strategies.<name>.sync.push: false` and `--no-push` |

Autonomy is never inferred: an absent `experimental` section, an absent key, and
an explicit `false` all read as off, so a partially-written or older config is
review-first rather than accidentally permissive.

Reflect, distill, extract candidates, validation, proactive-maintenance
selection, and graph extraction are proposal-only and never write assets
directly. Two further direct writes are ungated by design: `extract`'s session
indexing (additive `sessions/**` writes,
`processes.extract.indexSessions`, default on) and distill's
encoding-salience frontmatter stamp (metadata only).

## Internal

Not public interfaces. Listed so you can recognize them, not so you can rely
on them.

- **Migration surfaces** — the standalone `akm-migrate` tool owns the one-time
  0.8→0.9 cutover, storage migration, and recovery backups (`akm-migrate
  backup` / `restore`). `akm migrate` is a thin process forwarder; `akm backup`
  and `akm config migrate` are removed. `akm help migrate <version>` is Stable
  and only renders release notes.
- **`bun scripts/build-registry-index.ts`** — maintainer tooling for building a
  registry index. It is a repository script, not a CLI command (the former
  `akm registry build-index` subcommand was removed).
- **Environment variables** — see the table below.

### Environment variables

**Supported** — documented interfaces; changes get a CHANGELOG note:

| Variable | Purpose |
| --- | --- |
| `AKM_BUNDLE_DIR`, `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_CACHE_DIR` | Filesystem layout overrides |
| `AKM_LLM_API_KEY`, `AKM_EMBED_API_KEY`, `AKM_ENGINE_<NAME>_API_KEY` | Credential provision for `$VAR` config references |
| `AKM_LLM_ENDPOINT`, `AKM_LLM_BASE_URL` | Setup provider inference |
| `AKM_VERBOSE`, `AKM_DEBUG` | Diagnostics |
| `AKM_REGISTRY_URL` | akm registry mirror override |
| `AKM_NPM_REGISTRY` | npm mirror override — redirects BOTH the trusted-tarball host allowlist and package metadata lookups (`npm view`-equivalent resolution) to the given registry base, replacing `registry.npmjs.org` wholesale rather than merging with it |
| `AKM_SQLITE_JOURNAL_MODE` | SQLite journal mode (network filesystems) |
| `AKM_BIN` | Absolute `akm` path for scheduler registration |
| `AKM_INSTALL_DIR` | Install-script prefix |
| `AKM_UPGRADE_SKIP_CHECKSUM` | Recovery hatch for a broken upgrade checksum |

**Internal** — no compatibility guarantee, may vanish without notice:
`AKM_NODE_ENTRY`, `AKM_EVENT_SOURCE`, `AKM_SESSION_ID`, `AKM_AGENT_HARNESS`,
`AKM_EMBED_DETERMINISTIC`, `AKM_CLAUDE_PROJECTS_DIR`,
`AKM_FORCE_INIT_TMP_STASH`, `AKM_STATE_DIR`.

Anything matching `AKM_TEST_*` is test-only fault injection. Never set it.
`AKM_VERSION` is the only variable actually stripped from release builds, via
`bun build --define` (see `.github/workflows/release.yml`); no `src/` code
reads an `AKM_TEST_*` variable, so the compiled `akm` binary itself carries
none. That said, three fault-injection hooks are NOT compiled out and DO ship
in every install: `AKM_TEST_MIGRATION_FAIL_INDEX_QUARANTINE`,
`AKM_TEST_MIGRATION_FAIL_WORKFLOW_DELETE`, and
`AKM_TEST_MIGRATION_FAIL_RESTORE_AFTER` (`scripts/akm-migrate/`). The migration
tool ships separately from the compiled `akm` binary, so these throw-only hooks
remain physically present. At rest they are runtime-guarded no-ops unless the
exact internal test value is set. Never set them.

## On the horizon

These changes are planned and will land in a known future release. They
are not part of the current stability contract; you should plan migrations
around them.

**The 0.9.0 decision record is fully shipped.** The
[decision record](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/0.9.0-decisions.md) settles a set of
breaking changes; every one of them is now in the code, and each decision
carries its own shipped status.

Shipped from that record: **D1** (`#fragment` section selection),
**D2** (the `akm show <ref> toc|section|lines|frontmatter|full` view grammar is
gone — `#fragment` is the only section selector), **D4** (conceptId /
`bundle//` prefix browse), **D5** (`akm bundle` removed), **D6** (open `type`
set at runtime), **D7** (all six `--format` values everywhere), **D8** (the
`experimental.improveAutonomy` gate), **D9** (`--auto-accept` warn-and-ignore),
and partially **D10** (an `akm-migrate` binary now exists, though the code still
lives in this repo). **D3** shipped too, in the end: `akm mv` was removed in
0.9.0 (see the Renames bullet above), with `scripts/rekey-asset-ref.ts` as the
Internal replacement for the one capability nothing else covered.

- **0.10 — `config set`/`config unset` may drop the config dump** in favor of
  a compact `{ok, shape, key}` result; `akm config list` remains the full read.
- **0.10 — migration extraction.** The migration machinery leaves the CLI for
  a separately published `akm-migrate` package (see Internal above).
- **0.10 — `--auto-accept` hard error.** It is currently accepted-and-warned;
  see the Improvement loop entry.
- **0.10 — `BundleAdapter.placeNew()` wiring.** The interface declares
  `placeNew()` as an optional capability method, and 9 of the 11 built-in
  adapters already implement it (all but `okf` and `website-snapshot`;
  `claude` and `opencode` inherit theirs from the shared tool-dir factory),
  but nothing in the write path calls it —
  writes still resolve through AKM's native flat type→directory table.
  Placement for every existing bundle is already correct today; this is a
  deliberately sequenced routing change, not unfinished behavior. See
  [D12](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/0.9.0-decisions.md#d12--bundleadapterplacenew-stays-unwired-until-010)
  for why it is scoped out of 0.9.0. Nothing user-visible changes in 0.10 for
  this alone.
- **1.0 contract freeze** — the `[bundle//]conceptId[#fragment]` ref grammar,
  the supported source model, search behavior, and write-target rules are
  frozen at 1.0. The SDK and in-process plugin story ship on top of that
  frozen core.

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
  (independent of the feature-stability policy above).
- [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md) — the
  normative ref grammar.
- [`docs/architecture/specs/0.9.0-decisions.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/0.9.0-decisions.md)
  — the decision record behind the 0.9.0 surface changes.
- [`docs/reference/data-and-telemetry.md`](./docs/reference/data-and-telemetry.md) — what
  state akm reads and writes locally.
