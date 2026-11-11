# Stability and compatibility

Use this document to decide which AKM interfaces to depend on and what to migrate
before 0.11. It describes the **current 0.10 line**; replacements planned for 0.11
are identified separately. Exact command syntax lives in the [CLI reference](docs/reference/cli.md).

## How to read this

Every public command has one status. A narrower exception in its notes applies
only to the named flag, field, format, or behavior.

| Status | What you can rely on | What to do |
| --- | --- | --- |
| **Stable** | Supported for scripts and integrations. Changes within a minor line are additive; breaking changes require a CHANGELOG entry and migration guidance. | Use the documented interface and parse its documented fields. |
| **Evolving** | Supported, but flags, prompts, and payloads are still being refined. Breaking changes are documented; the 0.10 overlap policy below protects existing callers. | Follow release notes and keep integrations covered by tests. |
| **Experimental** | A named feature or contract is still under evaluation and may change between releases. Some capabilities require an explicit opt-in. | Use deliberately; do not assume a stable automation contract beyond the guarantees explicitly listed here. |
| **Deprecated** | Still supported through 0.10.x, with removal scheduled for **0.11.0**. Existing behavior and output remain available during that overlap. | Adopt the replacement in the command notes when it ships; if there is none, follow the stated removal guidance. |

Deprecation takes precedence over a command's former status. It does not loosen
its existing 0.10 guarantees. An Experimental feature inside a Stable command
does not make the rest of that command experimental. The same scope rule applies
to data formats, APIs, and configuration below.

- [Command status](#command-status): current commands, exceptions, and replacements.
- [0.10 additions and 0.11 removals](#010-additions-and-scheduled-011-removals): rollout rules and changes to prepare for.
- [Interface contracts](#interface-contracts): refs, output, execution, learning, APIs, and data.
- [Configuration and environment](#configuration-and-environment): supported controls and their migration paths.
- [Versioning and upgrade history](#versioning-and-upgrade-history): version numbers, compatibility floors, and spellings already removed.

## Command status

These tables cover the current CLI and its standalone migration executable.
**Deprecated means removal in 0.11.0** throughout. Replacement names describe the
target interface, not a promise that every installed 0.10 build already has it;
check the [migration guide](docs/migration/v0.10-to-v0.11.md) for availability.

### Find, read, and capture assets

| Command | Status | Contract or migration action |
| --- | --- | --- |
| `akm index` | Stable | `--export-vectors` and `--import-vectors` are Experimental for their first release; the vector file (`model`, `text_hash`, `embedding`) is their contract, the index file format stays internal. |
| `akm search` | Stable | |
| `akm curate` | Stable | `--max-tokens` aliases the existing `--pack` budget and output. Both are opt-in; the unbudgeted default stays unchanged. Conflicting explicit budgets are rejected. |
| `akm show` | Stable | `--outline` and `--lead` are additive aliases. `--max-tokens` bounds body fields on whole/exact/lead reads and reports estimation/truncation; legacy unbudgeted output is unchanged. |
| `akm remember` | Stable | `--source`, `--description`, and `--expires` work independently of tags. Capture and enrichment processes are unchanged. |
| `akm import` | Stable | |
| `akm sync` | Stable | |
| `akm clone` | Deprecated | Removed in 0.11: use `akm import <ref>` with equivalent asset, companion-file, and destination behavior. |
| `akm feedback` | Stable | |

### Bundles and registries

| Command | Status | Contract or migration action |
| --- | --- | --- |
| `akm bundle create` | Stable | |
| `akm bundle add` | Stable | |
| `akm bundle list` | Stable | |
| `akm bundle show` | Evolving | |
| `akm bundle rename` | Stable | |
| `akm bundle remove` | Stable | |
| `akm bundle update` | Stable | |
| `akm registry list` | Evolving | |
| `akm registry add` | Evolving | |
| `akm registry remove` | Evolving | |

### Execution, tasks, and workflows

| Command | Status | Contract or migration action |
| --- | --- | --- |
| `akm workflow status` | Experimental | `--all-scopes` added in 0.9.15 (#942); a deprecated no-op since 0.10 (#1239), accepted through 0.10. |
| `akm workflow plan` | Deprecated | Removed in 0.11: use `akm doctor explain <ref>`. Preserve secret-free provenance output and no execution. |
| `akm workflow list` | Experimental | `--all-scopes` and a top-level `scopeKey` envelope field added in 0.9.15 (#942); since 0.10 (#1239) `--all-scopes` is a deprecated no-op, accepted through 0.10, and the `scopeKey` field is removed from the list result. |
| `akm workflow create` | Experimental | |
| `akm workflow resume` | Experimental | |
| `akm workflow abandon` | Experimental | |
| `akm workflow run` | Deprecated | Removed in 0.11: use `akm run <ref>`; retain workflow lifecycle commands for existing runs. |
| `akm agent` | Deprecated | Removed in 0.11: use `akm run <ref>` for assets; invoke the agent's own CLI for the no-ref interactive launch. |
| `akm command run` / `akm command <ref>` | Deprecated | Removed in 0.11: use `akm run <ref>` with the same template arguments and dispatch. |
| `akm task add` | Deprecated | Removed in 0.11: use explicit typed-task import, then `task enable` when activation is wanted. |
| `akm task enable` | Evolving | |
| `akm task disable` | Evolving | |
| `akm task run` | Deprecated | Removed in 0.11: use `akm run <qualified-task-ref>` with the same inputs. |
| `akm task history` | Deprecated | Removed in 0.11: use `akm doctor log` for run history and `doctor metrics` for aggregates. |
| `akm task sync` | Deprecated | Removed in 0.11: use `akm doctor scheduler sync`, retaining reconciliation and rebind behavior. |
| `akm task prune` | Deprecated | Removed in 0.11: owned-orphan cleanup moves into migration/reconciliation; no separate prune command. |
| `akm task doctor` | Deprecated | Removed in 0.11: use `akm doctor` for scheduler checks. |
| `akm task explain` | Deprecated | Removed in 0.11: use `akm doctor explain <ref>` without execution. Current provenance output redacts secret-shaped values heuristically, not as a guarantee. |

### Learning, reporting, and diagnostics

| Command | Status | Contract or migration action |
| --- | --- | --- |
| `akm doctor` | Evolving | Reuses health checks, flags, output, and exits in 0.10, including transitional report flags. Full task-doctor consolidation is still planned. Use `--read-only --no-probe` for offline inspection without health writes. |
| `akm doctor metrics` | Evolving | Reuses `metrics`; its report content, layout, and JSON payload remain Experimental. Improve-run report selection is not yet consolidated here. |
| `akm doctor info` | Evolving | Reuses `info`, preserving its existing fields and broken-config recovery behavior; `learning` remains Experimental. |
| `akm doctor log` | Evolving | Reuses the existing event-stream command and output. |
| `akm doctor prompt` | Evolving | Reuses `improve --show-prompt`, preserving task, bundle, strategy and runner selection, output, and read-only behavior. The old form remains. |
| `akm doctor judge` | Evolving | Reuses registered judges, runner selection, JSON stdin, and versioned verdicts; invoking a judge can make model calls. |
| `akm health` | Deprecated | Removed in 0.11: use `akm doctor` for checks and `doctor metrics` for reporting. Current exit codes are Evolving; report content and rendered `md` layout are Experimental. |
| `akm metrics` | Deprecated | Removed in 0.11: use `akm doctor metrics`. Current report content and JSON shape are Experimental. |
| `akm info` | Deprecated | Removed in 0.11: use `akm doctor info`. The current `learning` field is Experimental for its first release. |
| `akm log` | Deprecated | Removed in 0.11: use `akm doctor log`. |
| `akm lint` | Evolving | |
| `akm improve` | Evolving | Gate-passed proposals are accepted and committed by default. The [three named autonomous lanes](#akm-improve-autonomy) require `experimental.improveAutonomy`; other documented writes do not. |
| `akm improve report` | Deprecated | Removed in 0.11: use `akm doctor metrics`, retaining run/window selection and usage, routing, and cost data. That consolidation is still planned; keep using this command until it is available. |
| `akm improve judge` | Deprecated | Removed in 0.11: use `akm doctor judge`. Subcommand since 0.10 (was a magic `scope` value); reads one revision as JSON on stdin and writes nothing. The same as `akm judge reflect.quality`, in its older input and output shape; its `--strategy` flag was removed. |
| `akm judge` | Deprecated | Removed in 0.11: use `akm doctor judge`. Runs a registered judge (`reflect.quality`, `distill.lesson`, `consolidate.pair`, `proposal.judgment`) on one JSON input from stdin, on the runner `--connection`, `--harness` and `--model` select. Output is one envelope (`judge`, `schemaVersion`, `runner`, `outcome`, `verdict?`, `reason?`); each judge carries its own `schemaVersion`. |
| `akm proposal list` | Stable | |
| `akm proposal show` | Evolving | The `legacy-ref` validation finding on a proposal recorded before concept IDs (#1513) is Experimental for its first release. |
| `akm proposal diff` | Evolving | |
| `akm proposal accept` | Evolving | |
| `akm proposal reject` | Evolving | |
| `akm proposal reopen` | Evolving | Undoes a rejection. |
| `akm proposal revert` | Evolving | |
| `akm proposal drain` | Evolving | |
| `akm proposal extract` | Evolving | Former top-level `akm extract`. Promoted from Experimental in 0.10 (#1133); extraction evals remain its qualification gate. This migration preserves its process and effective defaults. |
| `akm proposal new` | Evolving | Former top-level `akm propose`. |

### Configuration, installation, and help

| Command | Status | Contract or migration action |
| --- | --- | --- |
| `akm setup` | Stable | Answer flags (`--endpoint`, `--api-key-env`, `--name`, `--harness`, `--embedding`, ...) are new in 0.10. The old JSON-valued `setup --config` and `--probe` were removed; see [upgrade history](#connections-and-harnesses-in-010-1244). `--learning on\|off` and the `improve.enabled` key it writes are Experimental for their first release. |
| `akm upgrade` | Stable | Includes the plugin step. `--next` is Deprecated in favor of coordinated `--channel` selection. Checksums are verified by default; the explicit `AKM_UPGRADE_SKIP_CHECKSUM` recovery bypass is Deprecated for removal in 0.11. |
| `akm migrate status` | Evolving | Forwards to the standalone `akm-migrate` tool and renders its result through the normal `--format` pipeline. |
| `akm migrate apply` | Evolving | Forwards to the standalone `akm-migrate` tool and renders its result through the normal `--format` pipeline. |
| `akm-migrate status` / `akm-migrate apply` | Deprecated | Standalone executable removed in 0.11: use `akm migrate status` / `akm migrate apply`. |
| `akm config path` | Stable | |
| `akm config list` | Stable | |
| `akm config get` | Stable | Default bare-value shape unchanged; `--show-source` (opt-in) wraps it as `{ value, source }`. |
| `akm config set` | Stable | |
| `akm config unset` | Stable | |
| `akm config diff` | Evolving | Compares effective (post-`extends`) configs. |
| `akm models` | Evolving | The alias picks of a connection, then the models its endpoint lists, and `set` to change one. |
| `akm models set` | Evolving | Changes a connection's model alias. |
| `akm help` | Stable | |
| `akm help migrate` | Deprecated | Removed in 0.11 with no CLI replacement: read the published changelog and migration guide. |
| `akm hints` | Stable | Format-exempt agent guide; the brief guide is the default; `--detail full` selects the complete version. |
| `akm completions` | Stable | Format-exempt (emits shell script source). |

### Environment and secrets

| Command | Status | Contract or migration action |
| --- | --- | --- |
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

## 0.10 additions and scheduled 0.11 removals

This is the release schedule, not a claim that replacements already work in this
build. Ship compatible fixes and additive replacements in **0.10.x**; deprecate
the old interfaces but keep their behavior working through the entire series.
Remove the listed old commands, flags, and config paths in **0.11.0**, alongside
the listed incompatible default/result changes. Do not change existing 0.10
invocations, stdout schemas, or input interpretation to introduce a replacement.
This schedule governs the listed interfaces even where their previous status
allowed faster changes.
The [draft migration guide](docs/migration/v0.10-to-v0.11.md)
tracks availability, argument and output mappings, behavior changes, and remaining
`TODO(0.11:...)` work. Update it as the replacements land.

### Execution and diagnostics: add in 0.10.x, remove old paths in 0.11

Introduce the `run` and `doctor` replacements listed in [Command status](#command-status)
in 0.10.x. Keep type-specific execution inputs, task bundle identity, workflow
lifecycle operations, and each old command's output and side effects through 0.10.
Two diagnostic modes also move: `improve --show-prompt` to `doctor prompt`, and
`search --by-usage` to `doctor metrics`.

**All reporting belongs under `akm doctor` in 0.11.** Move reporting commands,
modes, and human report tables there, including improve's automatic post-run
usage/routing table. Use `doctor metrics` for reports and aggregates, `doctor log`
for events and run history, and the relevant doctor subcommand for other diagnostic
reports. Preserve recorded data and structured operation results; this changes
the CLI presentation, not learning internals. Ordinary lifecycle status and
operation results remain on their commands.

The diagnostic family is an explicitly evolving power-user surface. Its detailed
flags and reports may change faster than the core CLI; error/exit conventions,
credential redaction, and any machine fields promised to plugins or automation
still have explicit contracts. Ordinary operation previews such as `--dry-run`
stay with their commands.

### Other replacements: add in 0.10.x, remove old surface in 0.11

Introduce all replacements below during 0.10.x with an overlap period. Exact
first-supporting versions and unresolved argument mappings belong in the migration
guide; all old surfaces in the left column are scheduled for 0.11 removal.

| Deprecated — remove in 0.11 | Add or prepare in 0.10.x |
| --- | --- |
| `task add` | Explicit typed-task import; retain `task enable`/`disable` for host activation and unchanged legacy `task add` behavior |
| `task sync`, `task prune` | Explicit `doctor scheduler sync` maintenance and migration cleanup of owned orphan entries; no separate prune command |
| `task history` | Per-run history through `doctor log`; aggregate usage through `doctor metrics` |
| `clone` | Extend `import` for asset refs/typed assets and clone destinations without reinterpreting existing document inputs |
| Search `--include-proposed`, `--include-sessions` | Repeatable `--include key=value` to relax specified default exclusions while explicit filters remain in force |
| Show `--context`, `--max-chars`, and `--detail` | Add `--lead`, independent `--max-tokens`, and `--outline` in 0.10; retain existing defaults until the 0.11 cutover to exact reads. See the [complete argument review](docs/reviews/cli-surface-recommendations-2026-11-11.md#show-argument-review). |

Also ship compatible metadata/budget fixes and the shared `--config` override in
0.10.x, preserving old location resolution when that override is absent. Update
owned consumers after replacements ship; document deprecations without changing
old machine output. Branch-specific scheduler/storage migrations remain in 0.11.

`task run`, `task doctor`, and `task explain` follow the run/doctor mappings in
the command tables. Keep `task enable`, `task disable`, and the scheduler-facing
`task dispatch` introduced on the 0.11 branch.
**Keep duration shortcuts:** `3M` means 90 days, `3m` means three minutes;
The additive `--timeout` alias accepts positive integer milliseconds or `ms`,
`s`, `m`, `h`, `d`, `M` durations wherever `--timeout-ms` already applies.
Existing timeout scopes and defaults remain; equal explicit budgets are accepted,
and conflicting values are rejected.

### Learning: change the interface, preserve the processes

For both 0.10.x and 0.11, cleanup of improve and related automation/learning is
limited to CLI/configuration boundaries. Preserve the existing processes,
effective defaults, prompts/model requests, eligibility, judgment, acceptance,
publication, and evaluation evidence. Do not introduce proposal-only
defaults, replace the strategy engine, or unify autonomy policies as part of this migration.

Keep demonstrated product controls on the supported surface, move controls with
demonstrated evaluation/research value under `experimental`, and remove controls
without demonstrated value only when their removal preserves process behavior.
Migrate active research overrides without changing their values or precedence;
do not move every existing knob into `experimental` indiscriminately. Experimental
tuning overrides must retain existing defaults and the separate
`experimental.improveAutonomy` semantics. Exact key mappings and parity checks
remain completion work in the migration guide. Add the experimental aliases and
migration support in 0.10.x, keeping old keys/flags working with identical effective
settings; remove their old public paths in 0.11 after parity is verified.

### Command and argument usage metrics

0.10.x adds local, default-on measurement of every CLI command and supplied
argument, including help and unsuccessful attempts, for future keep/cut decisions.
Record argument identities and safe values, not raw argv or sensitive payloads;
separate explicit choices from defaults and AKM flags from child arguments.
Report version, source, instance, outcomes, and usage combinations through
`doctor metrics`, with a stable export for lab analysis and visible coverage gaps.
Collection stays outside learning feedback/ranking and does not change process
behavior. Preserve the collected baseline through the 0.11 storage migration;
the migration guide tracks the data contract, retention, and verification.

### Remaining scheduled 0.11 removals and breaking changes

The reviewed 0.11 branch already removes location environment variables, implicit
bundle selection, old config readers, obsolete flags, duplicate result keys, and
deep package imports, and replaces per-task OS scheduler entries. These are
unreleased branch changes; their replacements are in the migration guide's
[branch-change inventory](docs/migration/v0.10-to-v0.11.md#existing-011-branch-changes).

The following removals and cutovers are scheduled for **0.11.0**. Add compatible
replacement controls in 0.10.x; keep old defaults, result shapes, and spellings
until 0.11. Exact mappings still marked TODO are release work, not permission to
remove a research capability or skip its replacement.

| Remove/change in 0.11 | Replacement and 0.10.x preparation |
| --- | --- |
| General YAML output; general Markdown/JSONL support | JSON/text generally; Markdown for reports and JSONL for useful streaming cases |
| Global `--output`, `--detail` | Shell redirection; add command-specific limits, budgets, and outlines in 0.10.x |
| `remember --auto`, `--enrich` | Audit and add experimental replacements for demonstrated research uses in 0.10.x; remove old flags in 0.11, preserving enrichment internals |
| `remember --show-similar` | Separate retrieval operation |
| Old public paths for custom-strategy definitions and research-only process knobs | Add experimental aliases in 0.10.x feeding the unchanged strategy engine; remove old paths in 0.11 |
| `improve --require-feedback-signal` | Add an experimental setting in 0.10.x with equivalent scope, precedence, and eligibility |
| `improve --json-to-stdout` | Keep the flag and stdout contract in 0.10.x; expose equivalent run data through ordinary JSON output at the 0.11 cutover |
| Overlapping bulk proposal controls | Add equivalent replacement entry points in 0.10.x; enumerate retired controls in the guide and keep explicit-ID accept/reject |
| `upgrade --next` | Make explicit `--channel` selection consistent across CLI and plugins in 0.10.x |
| No-ref interactive `agent` launch | Invoke the agent's own CLI |
| `curate --pack` and the unpacked default | Add opt-in `--max-tokens` in 0.10.x; switch the default to bounded packed context and remove `--pack` in 0.11 |
| `lint --fail-on-flagged` | Nonzero exit for validation errors by default |
| `--timeout-ms` | Duration-based `--timeout`, introduced alongside it in 0.10.x |
| Invalid-value fallback and ignored incompatible legacy flags, including simultaneous `--quiet`/`--verbose` | Validate new interfaces in 0.10.x; tighten legacy behavior in 0.11 |
| Session extraction's source-harness `--type` | Add a distinct source selector in 0.10.x; retire the overloaded spelling in 0.11 |
| `help migrate <version>` | Read the published changelog and migration guide |
| Standalone `akm-migrate` executable | Use `akm migrate status` and `akm migrate apply` |

Before release, complete the exact mappings and synchronize this notice, the
[recommendations](docs/reviews/cli-surface-recommendations-2026-11-11.md), and the
migration guide. The command tables above are the current deprecation index.

## Interface contracts

The contracts below describe 0.10 behavior. The removal schedule above takes
precedence over older permissions to change or retain an interface.

## References, discovery, and asset identity

### Asset references (Stable)

Refs use `[bundle//]conceptId[#fragment]`. A `conceptId` is
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

### Prefix enumeration (Stable)

Search can enumerate prefixes such as `"memories/"`, `"memories/projecta/"`,
`"bundle//"`, and `"bundle//skills/"`; for example, `akm search "memories/"`.
A trailing `/` is required. The prefix matches the **conceptId** — the spelling every emitted
`ref` carries — so a ref copied out of search output can be truncated to a
prefix and pasted back in. Enumeration is not tied to any adapter's type set,
so every adapter's items browse the same way, and `bundle//` lists a whole
bundle (this replaced `akm bundle items`). A prefix is explicit intent, so
`search.defaultExcludeTypes` does not apply to it. The pre-0.9.0
`"<type>:"` / `"<type>:<prefix>/"` spelling was removed; a query in that
shape is now an ordinary keyword search whose empty-result tip names the
conceptId spelling that replaces it.

### Asset types (Stable)

`--type` matches an open set of strings; the value is deliberately **not validated**: an
unrecognized type returns zero hits, not an error. Adapters emit types
outside the built-in set, so there is no closed list to validate against —
`--type website` or `--type wiki-source` are ordinary, valid filters.

### Renames and learned state (Stable)

Moving or renaming an item gives it a new
identity; learned state (feedback, usage, salience) does not follow it.
Cross-bundle movement is copy/import plus delete. Move the file, then run
`akm index`, then `akm lint` to catch inbound refs the move left dangling.
There is no `akm mv`; `scripts/rekey-asset-ref.ts` re-keys earned signal from
an old ref to a new one and is repository maintenance tooling, not a public CLI command.

## Output, errors, and reporting

### Structured output and exit codes (Stable)

The documented JSON top-level keys are stable. The error
envelope is `{ok: false, error, code?, hint?}`: `ok` and
`error` are always present; `code` is a stable machine-readable identifier
present on every classified failure (exit 1 / 2 / 75 / 78) and absent only on
unexpected internal errors (exit 70); `hint` is best-effort and may be absent. Prefer
`code` over matching on `error` prose. Exit codes are listed below.

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

`--detail` is `brief|normal|full` (verbosity) or `agent` (the projection of
`search`, `curate` and `show`; see Agent-oriented output below). A small set of commands is **format-exempt** because their
output is not a result envelope at all: `completions` (shell script source),
child-process passthrough in `env run` / `secret run`, a bare-path payload
from `env path` and `config path`, and document payloads from `hints` and `help`
(bare and `help migrate`). The set is declared in
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
| `4` | Health warning (`akm doctor` or `akm health`) |
| `70` | Unexpected / unclassified |
| `75` | Transient — retry shortly (`TransientError`, sysexits `EX_TEMPFAIL`); another akm process holds a lock or is writing `state.db` or `index.db` right now |
| `78` | Configuration error |

### Agent-oriented output (Experimental)

`--detail agent` selects the agent projection on `search`, `show`,
and `curate`; other commands ignore it. It replaces
`--shape agent`; `--shape` (and `--shape summary`, which only `show` had) is
gone in 0.10 and is an unknown flag.

### Diagnostic reports (Deprecated entry points)

Health checks return 0 for pass, 4 for warning, and 1 for failure. `doctor`
preserves those exits; the old `health` entry point is Deprecated. Report content
(metrics and advisories) and rendered Markdown layout remain Experimental;
do not script against the human report layout.

`akm metrics` was introduced in 0.9.28. What it reports, its JSON shape and the
report layout are not a stable scripting contract. Preserve existing behavior
during the documented 0.10 overlap; do not parse the human layout.

`akm log` is the event-stream surface (0.9.0: the
asset-scoped `akm history` surface, and `log`'s own `tail` subcommand, were
both removed; `log` is now a leaf command — the former `list` surface).

Their replacements are `doctor`, `doctor metrics`, and `doctor log`. Preserve
existing 0.10 behavior; reporting moves entirely under doctor in 0.11.

## Bundles and registries

### Bundle model and adapters (Evolving)

Installed sources are *bundles*; each is
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

### LLM Wiki bundles (Evolving)

The Karpathy-style LLM wiki is a first-class built-in
bundle format (the `llm-wiki` adapter owns `schema.md` / `index.md` /
`log.md` / `raw/` / `pages/` and its ingest flow); wiki pages are addressed
as ordinary concepts inside their bundle. Adapter behavior and page
conventions are still iterating.

### Registry management (Evolving)

Manage registries with `akm registry {list,add,remove}` and search them with
`akm search --from registry` (0.9.0: `registry search` was folded into
`search`). Building a registry index is maintainer tooling and
lives outside the CLI, in `scripts/build-registry-index.ts`.

## Execution, tasks, and workflows

### Harnesses and runtime (Evolving)

Agent and command execution support these
harnesses: `claude`, `codex`, `opencode` (through `opencode run`, for OpenCode 2
and for the legacy OpenCode 1, which keeps working with no removal date),
`copilot`, `pi`, `gemini`, `aider`, `amazonq`, and `openhands`. Every harness is
Evolving: it translates a request into a command, using your environment as it is
([Configuration](docs/reference/configuration.md#how-akm-runs-a-harness)). With
no harness configured, agent work runs on akm's own runtime over a connection,
which is Evolving too.

### Model selection (Evolving)

Connections hold intent-based model aliases. Inspect them with `akm models`
and change an alias with `akm models set`.

### Task formats and execution (Evolving)

The 0.10 task commands are `add`, `enable`, `disable`, `run`, `explain`,
`history`, `sync`, `prune`, and `doctor`; there is no group alias and no
`list`, `remove`, `init`, or `validate`. Their individual deprecation statuses
are in the command table. Task source v4 YAML, with typed `inputs:` and an
optional `schedule:`, is the only accepted version. Task v3 and
task v2 sources are converted by `akm migrate apply`. Command tasks use
a named connection or harness, and task history metadata is versioned. Schema
additions can ship in patch releases; removals require a minor release. Bare `akm task` is a usage error
naming the subcommands (`akm task doctor` reports scheduler diagnostics).
`akm task explain <ref>` (new in 0.9.2) and `akm workflow plan <ref>` are
both zero-write provenance surfaces: they show what a task or workflow
would do — resolved target, input bindings, child expansion — without
starting or publishing a run. `akm workflow plan` is secret-free **by
construction** (the excluded data never reaches the command). `akm task
explain` instead **redacts** secret-shaped input values on a best-effort
heuristic basis — a value that doesn't match the heuristic can still
print unredacted.

### Execution-plan inspection

`akm workflow plan <ref>` (added in 0.9.2) inspects the compiled plan: its
canonical step graph, task/child expansion, input bindings, and lowering notices.
It writes nothing and does not start or publish a run. Its data contract has
been Experimental since 0.9.28. The entry point is Deprecated in favor of
`doctor explain`; that move preserves these no-execution semantics.

### Workflow formats and capabilities (Experimental)

The workflow asset format and engine remain Experimental from 0.9.28 and
throughout 0.10. The command table assigns each entry point its status:
`run` and `plan` are Deprecated; `status`, `list`, `create`, `resume`, and
`abandon` remain Experimental. The 0.10
series stabilizes the feature and trims what is not useful, then either
promotes it out of Experimental or removes it if stabilization does not
produce a quality feature. **Child workflows** (`unit: { workflow: … }`, a
step that runs another workflow and returns its last step's output) are the
least settled part and are kept only in that simple form; `akm workflow list
--children` goes with them.

Every key below remains Experimental until the promote-or-remove
decision in [#1096](https://github.com/itlackey/akm/issues/1096). The table records
what the 0.10 trim retained, not a promotion to Stable.

| Key | Retained scope |
| --- | --- |
| `params`, `steps`, `inputs`, `output` / `unit.output`, `defaults.connection` / `defaults.harness`, `### gate` | Core: the feature set pinned by `core-feature-set.test.ts` |
| exec units (`unit.exec`), `budget`, `unit.retry`, `map`, `gate.max_loops` | Kept in the 0.10 trim |
| child workflows (`unit.workflow`, `unit.with`) | Experimental: least settled |

## Learning and proposals

### Improvement and extraction (Evolving)

The improvement surface consists of `akm improve` and
`akm proposal {extract,new,list,show,diff,accept,reject,reopen,revert,drain}`
(`extract` and `new` are the former top-level `akm extract`/`akm propose`,
moved under `proposal` in 0.9.0). Output JSON keys
are stable; CLI flags (`--strategy`, `--task`, `--generator`) may add
options or tighten validation across releases. `akm improve` stays on by
default and is **proposal-first**: gate-passed proposals are accepted and
committed. Three named autonomous lanes require `experimental.improveAutonomy`;
other documented writes do not. See
[`akm improve` autonomy](#akm-improve-autonomy).
`--auto-accept` was removed in 0.9.0 and is an unknown flag (a usage error,
exit 2) since 0.10. The replacement is
`akm improve && akm proposal drain --promote --yes`, or a `triage` block
with `applyMode: "promote"` in your strategy.
**Session extraction** (`akm proposal extract` and the improve `extract`
process) is Evolving as of 0.10 (#1133): the extract eval (insights saved,
routine sessions left empty, planted instructions refused) is its gate. It
is Evolving because its usefulness and defaults are still being evaluated.
The current CLI/configuration migration must preserve extraction behavior,
effective settings, and evaluation evidence.

### Proposal records and classifications

Quality classifications (`accepted`, `pending`,
`proposed`, `rejected`, `archived`) are stable; the JSON shape of a
proposal record may add fields.

### Lessons

The `lesson` schema (`when_to_use`, `description`) is Stable. Distillation
triggers and ranking remain Experimental; this migration preserves them.

### Belief-state transitions (Experimental)

`captureMode`, `beliefState`, contradiction edges, and the consolidate journal
are observable. Their algorithms remain Experimental; this migration preserves
those algorithms and their effective settings.

### Built-in strategies and lanes (Experimental)

Any remaining built-in strategy other than `default` and `consolidate` is
Experimental. The earlier 0.10 evaluation under #1094 removed `quick`,
`reflect-distill`, `thorough`, and `catchup` (#1130), plus
`proactive-maintenance` and the high-salience lane (#1129). A user-defined
strategy with one of those names still works. The current CLI/configuration
migration preserves the remaining processes.

### Learning configuration (Experimental)

The tuning controls include `improve.strategies.*.processes.*` (limits,
gates, and the CLS knobs), `improve.processes.*` and `improve.qualityGate`
(where each process runs) and the `index.*` per-pass config. Earlier policy allowed these keys to be
added, renamed, or dropped in 0.9.x and 0.10.x. The current rollout supersedes
that permission: add equivalent experimental aliases in 0.10.x, retain old keys
through the series, and remove their old paths in 0.11 only after effective-value
and behavior parity is verified. The `akm improve` command remains Evolving;
this does not authorize changing its processes.

### `akm improve` autonomy

`akm improve` is proposal-first by default: it accepts and commits proposals
whose quality check passed. Schedules and reflect/distill proposals are enabled.
The three autonomous lanes in the table below require an explicit opt-in:

```sh
akm config set experimental.improveAutonomy true
```

An absent `experimental` section, an absent key and an explicit `false` all
read as off. Without the opt-in, these three lanes are downgraded (the triage lane only when its
judgment tier is on), and each downgrade is **reported,
not silent**: it warns on stderr naming the lane and the key, appends an
`improve_skipped` event with `reason: "autonomy_gated"`, is counted in
`akm health`'s improve skip-reason summary, and is listed by `akm task doctor`
under `improveAutonomy.gatedLanes` — which is where to look when a *scheduled*
run stops doing something it used to. `akm task doctor` also reports the
**effective** `improveTriage.applyMode`, so a judged `promote` strategy
without the opt-in correctly shows `queue`.

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

Because the gate is applied before the LLM preflight, a workspace without the opt-in
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

## Programmatic APIs

### Recall API (Evolving)

`akm-cli/api` exposes `curate()` for in-process recall by the AKM plugins; see
the [API reference](docs/reference/api.md). The recall export list only grows,
and `curate()`'s parameters and result keep their documented contract. The text
it returns is `akm curate`'s agent-shaped output and changes with it. The separate
workspace namespace is Experimental, described below.

### Local workspace API (Experimental)

`akm-cli/workspace` exposes typed operations (assets,
documents, proposals, bundles, config, feedback, env/secrets, activity), URL
redaction and the error classes for trusted local hosts. It is not a stable SDK: exports, signatures and
result shapes may change in any release. Hosts own authentication and
transport limits.
See [Programmatic APIs](docs/reference/api.md#local-workspace-akm-cliworkspace).

## Installation and persisted data

### Install scripts (Stable)

The `install.sh` and `install.ps1` URLs and the `AKM_INSTALL_DIR` environment
override are supported installation interfaces.

### Runtime support (Stable)

The npm package requires Node.js >= 22 as its bootstrap and
prefers a working Bun >= 1.0 for execution when both are available; old,
unusable, or absent Bun installations fall back to Node.js. Standalone
binaries are runtime-free.

### Data ownership and compatibility

Durable workspace state (events, proposals, history,
workflow runs, salience) lives in `state.db`; the search index (`index.db`)
is a fully **regenerable** cache rebuilt by `akm index`; high-volume logs stay
in a separate `logs.db`. Asset metadata lives as file-local frontmatter plus
the index (there is no separate metadata sidecar). Treat the on-disk schema
as internal (use `akm` commands, not direct SQL).

### Migration commands (Evolving)

`akm migrate status` inspects migration needs; `akm migrate apply` rewrites
config, `state.db`, task files, and old on-disk residue with a backup first. In
0.10 they forward to the standalone `akm-migrate` executable shipped in the
same npm package. That executable is Deprecated for 0.11; the `akm migrate`
commands remain. See [persisted-data compatibility](docs/architecture/persisted-data-compat.md)
for supported formats, conversion, newer-version handling, and recovery.

## Configuration and environment

Command and configuration status are independent: an Evolving command can have
Experimental tuning controls. [Learning configuration](#learning-configuration-experimental)
and the [configuration reference](docs/reference/configuration.md) identify those
exceptions; [protected values](#protected-values) describes env/secret guarantees.

### Environment overrides

These are the documented 0.10 controls. Deprecated controls continue to work
through 0.10; the 0.11 guide owns their exact replacements and conversion order.
Do not remove location overrides until the replacement config preserves the
existing data, state, and cache paths.

| Variable | Status | Purpose and migration |
| --- | --- | --- |
| `AKM_BUNDLE_DIR` | Deprecated | Bundle location override; register the bundle and select `defaultBundle` before 0.11. |
| `AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_CACHE_DIR`, `AKM_STATE_DIR` | Deprecated | Filesystem layout overrides; migrate to `AKM_CONFIG_FILE` / `--config` and config `paths` in 0.11. `AKM_STATE_DIR` was previously undocumented as a supported control but still needs migration when in use. |
| `AKM_VERBOSE`, `AKM_DEBUG` | Deprecated | Diagnostics; use the replacement verbosity/debug controls recorded in the migration guide. |
| `AKM_REGISTRY_URL` | Deprecated | Comma-separated URLs replace configured registries for every registry search; `registry list` and `info` still show the configured list. Migrate the selection to config. |
| `AKM_NPM_REGISTRY` | Evolving | npm mirror base URL instead of `registry.npmjs.org`; documented changes require a CHANGELOG note. |
| `AKM_SQLITE_JOURNAL_MODE` | Deprecated | SQLite journal mode override for network filesystems; migrate to the configured storage setting. |
| `AKM_INSTALL_DIR` | Stable | Install-script prefix. |
| `AKM_UPGRADE_SKIP_CHECKSUM` | Deprecated | Explicit recovery bypass for a broken checksum in 0.10; removed in 0.11. Normal upgrade verification remains mandatory. |

See the [environment migration inventory](docs/migration/v0.10-to-v0.11.md#existing-011-branch-changes)
for exact pending mappings. Runtime/test signals and repository scripts are
[maintainer implementation details](docs/maintainers/implementation-details.md),
not additional public support statuses.

### Protected values

An `env` asset holds a whole `.env` group; a `secret` holds a single sensitive
value. Env key names are discoverable. Values are never written to stdout, the index, or
structured output; the safe injection path is `akm env run <name> --
<command>` (or `akm secret run <name> <VAR> -- …`). The `env` / `secret`
**write** verbs (`env create`, `env remove`, `secret set`, `secret remove`) are Experimental; the
`list` / `path` / `run` / `export` read-and-inject surface is Stable.

### Validation (Evolving)

The `akm lint` rule set and finding shapes are Evolving. Its current
`--fail-on-flagged` behavior and exit codes remain stable through 0.10. The
flag is Deprecated for 0.11, when validation errors become nonzero by default.

## Versioning and upgrade history

`akm-cli` follows [Semantic Versioning](https://semver.org/) on the 0.x line
**with one caveat**: while the version is 0.x, minor releases (0.x → 0.x+1)
may include breaking changes.

### 0.10 compatibility floor (#1091)

0.10 reads what 0.9.15 and later wrote: config,
`state.db`, task sources, frozen workflow plans and scheduler rows. It does not
convert anything older. An install on an earlier release runs `akm migrate
apply` under akm 0.9.x first, then upgrades; a 0.10 reader that meets an older
shape refuses with one message saying so. See
[`docs/architecture/persisted-data-compat.md`](docs/architecture/persisted-data-compat.md).

### Spellings already removed in 0.10 (#1091)

Each of these is an unknown flag or
command (exit 2) from 0.10, with no alias and no deprecation period; the new
spelling is in the CHANGELOG entry and the CLI reference.

| Gone | Use |
| --- | --- |
| `akm help agents` | `akm hints` (`--detail full` for the complete guide) |
| `--shape agent` | `--detail agent` |
| `--shape summary` | `--detail brief` (it only had a projection on `akm show`) |
| `--target` on `import`, `env create`, `env remove`, `secret set`, `proposal accept`, `proposal diff`, `proposal revert` | `--bundle` |
| `akm task validate <path>` | `akm lint --type tasks` |
| `akm config path --all` | `akm info` |
| `--run` / `--since` on `akm improve` | `akm improve report --run` / `--since` |

### Connections and harnesses in 0.10 (#1244)

`engines` and `defaults` are
replaced by `connections` and `harnesses`. A config in the old form still loads
(converted in memory, with a warning that names `akm migrate apply`), and `akm
migrate apply` converts it.

`--engine <name>` (on `agent`, `command run`, `task add`, `proposal new` and
`proposal extract`) and `--require-engines` (on `improve`) are hidden from
`--help` and still run, with one warning, through 0.10. `--require-engines`
does nothing. Change a script to `--connection <name>` or `--harness <name>`,
and `--model <alias|name>`; how an old engine name resolves is under
[The `engines` form](docs/reference/configuration.md#the-engines-form).

`AKM_ENGINE_<NAME>_API_KEY`, `AKM_LLM_API_KEY` and `AKM_EMBED_API_KEY` are no
longer read implicitly: put `"apiKey": "$VAR"` on the connection, or the key in
`credentials.json`.

These are unknown flags or commands (exit 2) from 0.10, with no alias:

| Gone | Use |
| --- | --- |
| `akm setup --config <json>` and `--probe` | `akm setup --endpoint <url> --yes` and the other answer flags; `--no-probe` for an offline run (probing is the default) |
| `akm models list`, `akm models copy-defaults` | `akm models`, `akm models set <alias> <model>` |

### Release numbering (#1089)

A 0.10 release is numbered
`0.10.YYMMNN`: `YY` the UTC year, `MM` the month (`01` to `12`) and `NN` the
release within that month (`01` to `99`), each two digits. A release takes its
number when its branch, `release/<version>`, is cut: one above the highest `NN`
published that month at any stage, so the first release of 2026-10 is
`0.10.261001` and the next `0.10.261002`. Its prereleases are that number with
the stage and a counter appended, `0.10.261001-beta.1`, then `-beta.2`, then
`-rc.1`; the stable release is the bare number. Prereleases published before
this rule carry a bare stage (`0.10.261115-beta`). Prereleases publish to the
npm `next` tag and stable releases to `latest`; `akm upgrade --next` follows
`next`. `next` never moves backwards: a prerelease of an older line published
after a newer line's gets that line's tag instead, `next-0.10`. Versions sort
by month and then `NN`, so semver ranges and `akm upgrade`
order them correctly across months and years. The patch number no longer says
how big a change is: read the CHANGELOG, which still marks breaking changes. The
0.9 line keeps `0.9.N`; the planned 0.11 line returns to plain semver
(`0.11.0`, `0.11.1`), as described in the
[draft migration guide](docs/migration/v0.10-to-v0.11.md).

The 0.10 daily alphas (`0.10.26101001-alpha` through `0.10.26101202-alpha`) used
an 8-digit patch, `YYMMDDNN`. Semver compares the patch numerically, so every
`0.10.YYMMNN` sorts below them and `akm upgrade` does not offer it from a daily
alpha: install the first monthly release explicitly once (for example
`npm install -g akm-cli@0.10.261001-beta`). This is a known, accepted break and
`tests/semver-order.test.ts` pins it.

## On the horizon

The 0.11 removals and replacements are scheduled above. A previously proposed
0.10 change to `config set` / `config unset` would have replaced the config dump
with a compact `{ok, shape, key}` result. That is an incompatible output change:
keep the 0.10 result and make any cutover in 0.11 with migration guidance;
`config list` remains the full read.

The **1.0 contract freeze** covers ref grammar, the supported source model,
search behavior, and write-target rules. The SDK and in-process plugin contract
will build on that frozen core.

## Reporting stability regressions

Report a broken documented contract at <https://github.com/itlackey/akm/issues>
with the `regression` label, AKM version, invocation, and expected versus actual
behavior. Stable-surface regressions are priority bugs. Report missing migration
notes for Deprecated/Evolving changes and undocumented Experimental changes too.

## See also

- [`CHANGELOG.md`](./CHANGELOG.md) — every release's behavior changes.
- [`SECURITY.md`](./SECURITY.md) — supported versions and how to report a
  vulnerability.
- [`docs/architecture/specs/ref.md`](https://github.com/itlackey/akm/blob/main/docs/architecture/specs/ref.md) — the
  normative ref grammar.
- [`docs/reference/data-and-telemetry.md`](./docs/reference/data-and-telemetry.md) — what
  state akm reads and writes locally.
