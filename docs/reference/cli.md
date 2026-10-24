# CLI Reference

`akm` (Agent Knowledge Manager) is a command-line tool.
This page is authoritative for the current CLI. It lists each command in the
order `akm --help` shows them: what it is for, the flags most people need, and
one example. It is a map, not a flag dump: `akm <command> --help` (or `akm help
<command>`) prints every flag and is always current.

Stability tiers per command are in [STABILITY.md](../../STABILITY.md). Commands
marked Experimental below can change in any release. For the bundle formats akm
recognizes, see [Bundle Types](bundle-types.md).

## Global flags

Every command accepts these.

| Flag | Values | Default | Meaning |
| --- | --- | --- | --- |
| `--format` | `json`, `jsonl`, `yaml`, `text`, `md`, `html` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full` | `brief` | How much each result carries |
| `--shape` | `human`, `agent`, `summary` | `human` | Output projection (Experimental) |
| `--output <path>` | file path | stdout | Write the rendered output to a file (all formats except `jsonl`) |
| `--quiet`, `-q` | boolean | off | Suppress non-essential stderr output |
| `--verbose` | boolean | off | Print per-spec diagnostics to stderr; `AKM_VERBOSE` does the same |

The defaults for `--format` and `--detail` come from the `output.format` and
`output.detail` config keys (see [Configuration](configuration.md)).

- `--format json`, `jsonl` and `yaml` serialize the result. `text`, `md` and
  `html` render it; commands without a dedicated renderer get a generic one
  built from the result's own keys. `jsonl` prints one hit per line for
  `search` and the whole result as one line elsewhere. `html` is a
  self-contained document.
- `--shape agent` trims `search`, `show` and `curate` to the fields an agent
  acts on (it adds the absolute `path` and `editable`). `--shape summary` is
  implemented only for `akm show`; on any other command it warns on stderr and
  falls back to `agent`.
- `completions`, `help`, `hints`, `env run`, `secret run` and `env path` are
  format-exempt: their output is a script, a document, a child process's output
  or a bare path. Passing `--format` to them warns and is ignored.
- Every list-returning command (`search`, `curate`, `proposal list`,
  `bundle list`, `env list`, `secret list`, `registry list`, `workflow list`,
  `task history`, `log`, `config diff`, `models list`) also carries a
  `results` field holding the same array as its own collection key
  (`hits`, `items`, `proposals`, `sources`, `envs`, `secrets`, `registries`,
  `runs`, `rows`, `events`), so one accessor works across them.

## Output envelope and exit codes

A successful command prints its result to stdout. Management commands
(`bundle`, `config`, `registry`, `remember`, `task`, ...) include `ok: true`, a
`shape` name and a `schemaVersion`; `search` and `show` return their own
fields. A failure prints a JSON envelope to stderr and leaves stdout empty:

```json
{"ok": false, "error": "<message>", "code": "<ERROR_CODE>", "hint": "<optional remediation>"}
```

`code` is present for errors akm classifies; `hint` only when there is an
actionable next step. Check the exit code, or `ok === false` on the parsed
stderr envelope.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Not found, or a command-reported failure |
| 2 | Usage error (bad flag, missing argument, bare command group) |
| 4 | Health warning (`akm health` only) |
| 70 | Internal or unclassified error |
| 75 | Transient: another akm process holds a lock or is writing `state.db` or `index.db`; retry shortly |
| 78 | Configuration error |

`env run` and `secret run` exit with the child process's status.

## Search output fields

`akm search` returns these fields per local hit, by `--detail` level:

| Level | Fields |
| --- | --- |
| `brief` (default) | `type`, `name`, `ref`, `action`, `estimatedTokens`, `keys` |
| `normal` | `type`, `name`, `description`, `action`, `score`, `estimatedTokens`, `warnings`, `quality`, plus `keys` when non-empty |
| `full` | the whole hit, including `ref`, `itemRef`, `bundleId`, `conceptId`, `origin`, `tags` and `whyMatched` |
| `--shape agent` | `name`, `ref`, `type`, `path`, `editable`, `description`, `action`, `score`, `estimatedTokens`, `keys`, and `editHint` when `editable` is `false` |

`ref` is present at `brief`, `full` and `--shape agent`, and absent at
`normal`. `path` and `editable` appear only with `--shape agent`.

Registry hits (`registryHits` in the result, never mixed into `hits`) carry
`name` and `score` at `brief`; `normal` adds `description`, `action` (which
holds the `akm bundle add` command) and `warnings`; `full` is the whole hit,
including `type`, `id` and `registryName`. See [Registry](registry.md).

## Commands

### setup

Configuration wizard for connections, agent profiles, bundles and registries.
It needs a terminal unless you pass `--yes`, `--config` or `--from`.

| Flag | Meaning |
| --- | --- |
| `--yes` | Accept all defaults, no prompts (safe to re-run in CI) |
| `--config <json>` / `--from <file>` | Apply configuration non-interactively from JSON or a JSON/YAML file (not both) |
| `--dir <path>` | Bundle directory to use |
| `--probe` | Check LLM and embedding endpoints before writing config |

```sh
akm setup --yes
akm setup --from ./akm-config.yaml --yes
```

Run `akm setup --help` for every flag.

### index

Build or refresh the search index (`index.db`). Incremental by default.
`akm index` fetches a bundle only if it has never been materialized on this
host; it never refreshes one (`akm bundle update` does), and `--full` does not
change that.

| Flag | Meaning |
| --- | --- |
| `--full` | Reindex everything |
| `--clean` | Drop index entries whose source file is gone (add `--dry-run` to preview) |
| `--reembed` | Discard stored vectors and re-embed under the configured model |
| `--skip-if-locked` | Exit 0 instead of contending when another index run holds the rebuild lock |

```sh
akm index
akm index --full
```

Run `akm index --help` for every flag.

### health

Check runtime health: `state.db`, engines, the scheduler, and recent improve
activity. Exits 0 for pass, 4 for warn, 1 for fail. The report layout under
`--format md` and `html` is Experimental.

| Flag | Meaning |
| --- | --- |
| `--since <window>` | Window start: ISO timestamp, date, epoch ms, or `24h` / `7d` |
| `--report` | Full report dataset: per-run rows, trends, the pending proposal queue |
| `--no-probe` | Skip the endpoint reachability probes and the GitHub release check (offline hosts) |

```sh
akm health
akm health --since 7d --report --format html --output health.html
```

Run `akm health --help` for every flag. The checks are listed in
[`akm health` checks](../architecture/internals/health-advisories.md).

### metrics

Experimental. Read-only report of asset usage, feedback, LLM usage, tasks,
proposals and workflow spend from local records. `--format html` writes a
self-contained dashboard.

| Flag | Meaning |
| --- | --- |
| `--since <window>` | ISO, date, epoch ms, or `24h` / `7d` / `30d` (default 30 days) |

```sh
akm metrics --since 7d --format html --output metrics.html
```

Run `akm metrics --help` for every flag.

### info

Show system capabilities, configuration and index statistics. Takes no
command-specific flags.

```sh
akm info
```

Run `akm info --help` for every flag.

### bundle

Create and manage bundles: the working bundle plus configured sources.

| Subcommand | Purpose |
| --- | --- |
| `create` | Initialize the working bundle directory (`--dir`, `--set-default`) |
| `add <ref>` | Add a source: local directory, git URL, `owner/repo`, npm package or website |
| `list` | List configured bundles (`--kind filesystem,git,npm,website`) |
| `show <name>` | Show one configured bundle |
| `remove <target>` | Remove a bundle (`--yes` skips the prompt) |
| `update [target]` | Refresh one bundle, or every bundle with `--all`; reconciles the index |
| `rename <old> <new>` | Rename a bundle everywhere akm records it (`--dry-run` previews) |

`bundle add` flags worth knowing: `--name`, `--provider website|npm` (required
for URL sources), `--writable` (git bundles you want to push to), `--adapter`
(override the detected bundle type), `--before` / `--after` (position in
search order), `--max-pages` and `--max-depth` (website crawls), and
`--allow-insecure-transport` / `--allow-dangerous-env-keys` (each overrides one
specific refusal). See [Website sources](website-sources.md) and
[Configuration](configuration.md).

```sh
akm bundle create
akm bundle add github:owner/skills --name team
akm bundle add https://docs.example.com --provider website --name docs --max-pages 100
akm bundle update --all
akm bundle rename team platform --dry-run
```

Run `akm bundle <subcommand> --help` for every flag.

### upgrade

Upgrade akm to the latest release, run pending migrations, rebuild the index,
and update the akm plugin of each installed harness (Claude Code, Codex,
OpenCode).

| Flag | Meaning |
| --- | --- |
| `--check` | Report what would be updated; change nothing |
| `--force` | Reinstall even when already on the latest release |
| `--next` | Follow the prerelease (`@next`) channel |
| `--skip-post-upgrade` | Skip the index rebuild afterwards |

```sh
akm upgrade --check
akm upgrade
```

Run `akm upgrade --help` for every flag. See
[Data and telemetry](data-and-telemetry.md) for the hosts `upgrade` contacts.

### search

Search indexed assets, and optionally registries.

| Flag | Meaning |
| --- | --- |
| `--type <type>` | Filter by asset type (free-form; an unknown type returns no hits) |
| `--limit <n>` | Maximum results (default 20) |
| `--from local\|registry\|all` | Where to search (default `local`) |
| `--filter <key>=<value>` | Scope filter, repeatable: `user`, `agent`, `run`, `channel` |

Also: `--belief all|current|historical` (memory belief state),
`--include-proposed`, `--include-sessions`. A query ending in `/` lists a
subtree instead of keyword-matching: `akm search "memories/projectA/"`,
`akm search "team//"`. Local results include `searchMode` (`semantic`,
`keyword` or `fts-fallback`). Hits are ordered by keyword and vector
relevance, and [`akm feedback`](#feedback) adjusts the order within a bounded
range. Fields per detail level are in [Search output fields](#search-output-fields).

```sh
akm search "deploy" --type script --limit 10
akm search "lint" --from registry
akm search "knowledge/"
```

Run `akm search --help` for every flag.

### curate

The usual starting point for an agent: picks the assets worth loading for a
task, with a preview and run details per hit and related support refs.

| Flag | Meaning |
| --- | --- |
| `--limit <n>` | Maximum curated results (default 4) |
| `--type <type>` | Filter by asset type |
| `--pack <tokens>` | Return the top hits' content packed into one blob within a token budget |

```sh
akm curate "deploy a service to staging"
akm curate "review a pull request" --pack 4000
```

Run `akm curate --help` for every flag.

### show

Display one asset by ref. The ref grammar is `[bundle//]conceptId[#fragment]`;
see [Refs](refs.md). `#fragment` selects one section of a markdown document by
heading slug, and an unmatched fragment lists the available slugs. `show`
reads the local index and the file on disk.

| Flag | Meaning |
| --- | --- |
| `--filter <key>=<value>` | Resolve only an asset whose frontmatter scope matches (repeatable) |
| `--context lead` | With a fragment: return the document lead plus the selected section |
| `--max-tokens <n>` / `--max-chars <n>` | Budget for `--context lead` (mutually exclusive) |

`show` returns `ref`, `path` and `editable` plus type-specific fields
(`content` for markdown assets, `run` and `setup` for scripts, `template` for
commands, `prompt` for agents, `keys` for env files). `--shape summary` gives a
compact capability view.

```sh
akm show skills/code-review
akm show knowledge/guide#authentication
akm show memories/retro --filter user=alice
```

Run `akm show --help` for every flag.

### workflow

Experimental. Author, inspect and run step-by-step workflow assets. See
[Workflows](workflows.md) and the [Workflow schema](workflow-schema.md).

| Subcommand | Purpose |
| --- | --- |
| `run <ref or run id>` | Start or resume a run and execute it (`--max-steps`, `--max-retries`, `--timeout`, `--new`, `--skip-if-locked`) |
| `plan <ref>` | Compile a workflow and print the frozen plan without writing anything |
| `status <ref or run id>` | Show a run's full state (`--units` adds per-unit rows) |
| `list` | List runs (`--ref`, `--active`, `--children`, `--all-scopes`) |
| `create <name>` | Create a workflow in the working bundle (`--from <file>`, `--path`, `--print`) |
| `resume <run id>` | Reopen a blocked or failed run |
| `abandon <run id>` | Mark a run failed so it stops counting as active |

```sh
akm workflow create release --path ops
akm workflow plan workflows/ops/release
akm workflow run workflows/ops/release
akm workflow list --active
```

Run `akm workflow <subcommand> --help` for every flag.

### remember

Record a memory in the write target. Content comes from the argument or stdin.

| Flag | Meaning |
| --- | --- |
| `--name <name>` / `--path <subdir>` | File name (flat) and subdirectory under `memories/` |
| `--tag <tag>` | Tag, repeatable |
| `--supersedes <ref>` | Correct an existing asset: writes this memory and demotes the old one |
| `--bundle <name>` | Write to a specific writable bundle |

Also: `--description`, `--expires 30d`, `--source`, `--xref <ref>`, `--auto`
(heuristic tagging), `--enrich` (LLM tags and description), `--force`, and the
scope flags `--user`, `--agent`, `--run`, `--channel`.

```sh
akm remember "Deploys to staging need the VPN" --tag ops --name vpn-note
echo "Retry the flaky test once before filing a bug" | akm remember --tag testing
```

Run `akm remember --help` for every flag.

### import

Import a document, URL or stdin (`-`) into `knowledge/` in the write target.

| Flag | Meaning |
| --- | --- |
| `--name <name>` / `--path <subdir>` | File name and subdirectory under `knowledge/` |
| `--target <name>` | Write to a specific writable bundle |
| `--supersedes <ref>` | Import a correction and demote the asset it replaces |
| `--force` | Overwrite an existing document |

```sh
akm import ./notes/api-guide.md --name api-guide
akm import https://example.com/runbook --path runbooks
```

Run `akm import --help` for every flag.

### sync

Commit changes in a git-backed bundle, and push when the bundle is writable
and has a remote. A no-op for bundles that are not git repositories.

| Flag | Meaning |
| --- | --- |
| `[name]` | Git bundle to sync (default: the working bundle) |
| `-m`, `--message <text>` | Commit message (default: a timestamp) |
| `--no-push` | Commit only |

```sh
akm sync -m "Add deploy skill"
akm sync team --no-push
```

Run `akm sync --help` for every flag.

### clone

Copy an asset into a writable bundle (or any directory with `--dest`) so you can
edit it. The source can be a remote locator such as an npm package, which is
fetched to the cache without being added as a bundle.

| Flag | Meaning |
| --- | --- |
| `--name <name>` | Name for the copy |
| `--bundle <name>` | Destination bundle (default: write target) |
| `--dest <dir>` | Copy to an unmanaged directory instead (cannot combine with `--bundle`) |
| `--force` | Overwrite an existing asset |

```sh
akm clone skills/code-review --name my-review
akm clone "npm:@scope/pkg//scripts/deploy.sh" --dest ./project/.claude
```

Run `akm clone --help` for every flag.

### registry

Manage the registries `akm search --from registry` queries. See
[Registry](registry.md).

| Subcommand | Purpose |
| --- | --- |
| `list` | List configured registries |
| `add <url>` | Add a registry (`--name`, `--provider static-index\|skills-sh`, `--options <json>`); adding a URL that is already configured does nothing |
| `remove <url or name>` | Remove a registry (`--yes` skips the prompt) |

```sh
akm registry list
akm registry add https://example.com/index.json --name team-index
```

Run `akm registry <subcommand> --help` for every flag.

### migrate

Inspect or apply pending migrations of config, `state.db` and task sources.
`akm upgrade` runs `migrate apply` for you.

| Subcommand | Purpose |
| --- | --- |
| `status` | Read-only check of every pending migration |
| `apply` | Back up and apply them (`--dry-run` checks eligibility only) |

```sh
akm migrate status
akm migrate apply --dry-run
```

Run `akm migrate <subcommand> --help` for every flag. Release notes:
`akm help migrate <version>`.

### config

Read and write `config.json`. See [Configuration](configuration.md).

| Subcommand | Purpose |
| --- | --- |
| `path` | Print the config path (`--all` adds the bundle, cache and index paths) |
| `list` | Print the current configuration |
| `get <key>` | Read one key (`--show-source` reports `local`, `extends:<ref>` or `default`) |
| `set <key> <value>` | Set a key (`--silent` suppresses the printed config) |
| `unset <key>` | Remove an optional key |
| `diff <file or bundle//path>` | Compare effective configs; secrets are redacted |

```sh
akm config get output.format
akm config set output.detail normal
akm config path --all
```

Run `akm config <subcommand> --help` for every flag.

### feedback

Record whether an asset helped. Feedback moves the asset's scores immediately.
The feedback score adjusts the asset's search rank within a bounded range
(about a quarter of its fused score either way); it is stored in the index and
rebuilt from the last 90 days of feedback on reindex, so feedback older than
that no longer counts. The utility score orders `akm improve`'s work.

| Flag | Meaning |
| --- | --- |
| `--positive` | The asset helped |
| `--negative --reason "<text>"` | The asset is wrong or unhelpful, and why |
| `--replace "<text>" --with "<text>" --source "<where it comes from>"` | Queue an exact text correction as a proposal (negative feedback only; repeatable) |
| `--superseded-by <ref>` / `--outdated` | Mark the asset's history, with `--reason` and `--source` |

```sh
akm feedback skills/deploy --positive
akm feedback lessons/deploy --negative --reason "Step 3 uses a removed flag"
```

Run `akm feedback --help` for every flag.

### log

List events from the append-only events stream in `state.db`.

| Flag | Meaning |
| --- | --- |
| `--since <t>` | ISO timestamp, epoch ms, or `@offset:<id>` to resume from a row id |
| `--type <type>` / `--ref <ref>` | Filter by event type or asset ref |
| `--limit <n>` | Only the most recent N matching events |

```sh
akm log --since 2026-10-01 --type feedback
akm log --ref skills/deploy --limit 20
```

Run `akm log --help` for every flag.

## Improvement Flow

`agent`, `command`, `lint`, `improve` and `proposal` are the agent-dispatch and
self-improvement surface. `akm improve` writes proposals to a queue and `akm
proposal` reviews them. When reinforced facts need promotion, `knowledge` is
the higher-authority destination than `memory`.

### agent

Dispatch an agent CLI (OpenCode, Claude, and the other registered harnesses),
optionally embodying an agent asset. Evolving.

| Flag | Meaning |
| --- | --- |
| `[agent-ref]` | Agent asset whose persona and model defaults to use |
| `--prompt <text>` / `--prompt-stdin` | The task |
| `--engine <name>` / `--model <alias or id>` | Override the engine and model |
| `--cwd <dir>` | Working directory for the spawned agent |

```sh
akm agent agents/code-reviewer --prompt "Review the staged changes"
```

Run `akm agent --help` for every flag.

### command

Run a stored command template (`commands/<name>`) through the same execution
resolver as `akm agent`.

| Flag | Meaning |
| --- | --- |
| `run <ref>` | Resolve the command, apply arguments and execute one fresh session |
| `--arguments <text>` | Text substituted for each `$ARGUMENTS` in the template |
| `--engine` / `--model` / `--agent` | Override the engine, model or agent selector |
| `--dry-run` | Lower the command and print diagnostics without dispatching |

```sh
akm command run commands/review --arguments "src/cli.ts" --dry-run
```

Run `akm command run --help` for every flag.

### lint

Scan a bundle's markdown for structural problems: bad frontmatter, missing
fields, stale paths and broken refs. Exits 0 regardless of findings unless
`--fail-on-flagged` is set.

| Flag | Meaning |
| --- | --- |
| `--fix` | Apply the auto-fixable repairs in place |
| `--fail-on-flagged` | Exit non-zero when anything is flagged (for CI) |
| `--dir <path>` | Lint a different bundle root |
| `--type <type>` | Lint only one asset type (akm bundles only) |

```sh
akm lint
akm lint --fail-on-flagged
```

Run `akm lint --help` for every flag.

### improve

Analyze existing assets and write improvement proposals to the proposal queue.
Review-first: proposals queue for `akm proposal accept` unless you opt into
automatic acceptance (`experimental.improveAutonomy`; see
[Configuration](configuration.md#experimental-opt-ins) and
[STABILITY.md](../../STABILITY.md)). The optional scope is an asset type, an
asset ref (`skills/code-review`, or `team//skills/code-review` to name the
bundle), `report` or `judge`.

```sh
akm improve
akm improve memory
akm improve skills/code-review --task "tighten the description"
akm improve --dry-run
akm improve --plan --strategy thorough        # preview engine and model routing; nothing is dispatched
akm improve lessons/my-lesson --show-prompt --format text   # print the composed reflect prompt for one asset
akm improve report --since 7d
akm improve --skip-if-locked --require-engines   # for scheduled runs
```

| Flag | Description |
| --- | --- |
| `--strategy <name>` | A built-in strategy (`catchup`, `consolidate`, `default`, `proactive-maintenance`, `quick`, `reflect-distill`, `thorough`) or an entry under `improve.strategies` |
| `--dry-run` | Print the planned work without writing config, state, bundle files or result artifacts |
| `--plan` | Alias for `--dry-run`. Use it to read `plan.processes`, the resolved process -> engine -> model routing |
| `--bundle <name>` | Bundle to improve and write proposals to (default: `defaultWriteTarget`, else the working bundle); only its assets are planned |
| `--limit <n>` | Maximum assets to process, highest salience first |
| `--task "<text>"` | Extra guidance for this pass |
| `--timeout-ms <ms>` | Wall-clock budget for the run (default 7200000, 2 hours) |
| `--require-feedback-signal` | Turn the fallback lanes (high salience, proactive maintenance) off: they only select and score assets, and a rewrite needs negative feedback |
| `--skip-if-locked` | Exit 0 instead of failing with "already running" (exit 75) when another improve run holds the lock |
| `--require-engines` | Exit 78 before any side effect if a process the strategy enables has an engine or credential that cannot be resolved, or whose endpoint fails a bounded reachability probe. Without it, improve skips those processes and lists them in `skippedProcesses` in the result |
| `--show-prompt` | Print the composed reflect prompt for one asset and exit, without taking the lock, writing the index or calling an engine. Needs a fully-qualified asset ref as the scope. The default output format is JSON, which carries the prompt escaped in a `prompt` field; add `--format text` to print the prompt itself |
| `--sync` / `--no-sync`, `--push` / `--no-push` | Commit (and push) the git-backed bundle when the run finishes. Default: on for git-backed bundles |
| `--json-to-stdout` | Also print the full persisted run result as JSON |
| `--run <id>` / `--since <window>` | `report` scope only: pick the run or time window to report on |

A run improves one bundle: the write target, or the one named by `--bundle` or
a bundle-qualified scope. Schedule one `akm improve --bundle <name>` run per
bundle you want covered.

`plan.processes` has one row per improve process (`reflect`, `distill`,
`consolidate`, `memoryInference`, `extract`, `validation`, `triage`,
`proactiveMaintenance`). Each row carries `enabled`, the resolved `engine`,
`model` and `engineKind`, lowering `notices`, and, for reflect, distill and
consolidate, `eligibleRefs`. A row whose engine or credential cannot be
resolved carries `unavailable: {configKey, reason}`. The table is resolved on
every invocation, so `--dry-run --strategy <name>` previews a strategy override
without changing config. Neither `--dry-run` nor `--plan` probes engine
reachability; `akm health` does.

`--show-prompt` is the cheapest way to exercise reflect alone: it builds the
exact prompt reflect would send for one asset, using the same source
resolution, feedback and rejected-proposal gathering as a live run, and prints
it without reading a credential. Add `--format text` to read it by eye; the
default JSON envelope escapes the prompt into one line.

`akm improve report` shows the LLM usage and routing report for the most recent
real run: `--run <id>` selects one run, `--since <window>` (a duration such as
`24h` or `7d`, or an ISO timestamp) aggregates every real run since then. Every
real run persists a `usageReport` on its result with `byProcessEngineModel`
(calls, failures and token counts per process, engine and model) and `noCalls`
(enabled model-calling processes that made no call, with the reason).
`akm improve judge` runs the reflect quality judge on a revision read as JSON
from stdin and writes nothing.

`--auto-accept` is ignored with a warning and becomes an error in 0.10. Use
`akm improve && akm proposal drain --promote --yes`, or a `triage` block with
`applyMode: "promote"` in your strategy.

Run `akm improve --help` for every flag.

### proposal

Work the proposal queue that `improve`, `feedback` and `proposal new` fill.

| Subcommand | Purpose |
| --- | --- |
| `proposal list` | List proposals (`--status`, `--ref`, `--type`, `--generator`) |
| `proposal show <id>` / `proposal diff <id>` | Show a proposal and its findings, or its diff (id, id prefix or asset ref) |
| `proposal accept [id]` | Promote a proposal into the bundle; `--generator <name>` accepts a whole group (`--dry-run`, `--yes`, `--max-diff-lines`, `--older-than`) |
| `proposal reject [id] --reason <text>` | Reject, with a reason; also takes `--generator` for bulk |
| `proposal reopen <id>` | Move rejected proposals back to pending (full ids, repeatable) |
| `proposal revert <id>` | Restore the content an accepted proposal replaced |
| `proposal drain` | Process the pending backlog: reject empty diffs, and with `--promote` accept what the quality judge passed (`--dry-run`, `--yes`, `--max-accepts`, `--strategy`) |
| `proposal new [type] [name]` | Ask the configured engine to author a new asset and queue it |
| `proposal extract` | Experimental. Extract insights from native session files (`--type claude\|codex\|opencode` or `--auto`, `--since`, `--dry-run`) |

```sh
akm proposal list --status pending
akm proposal diff skills/code-review
akm proposal accept skills/code-review
akm proposal reject skills/code-review --reason "Drops the rollback step"
akm proposal drain --dry-run
```

#### proposal new

Authors a brand-new asset through a named engine and queues it as a proposal
rather than writing it.

| Flag | Meaning |
| --- | --- |
| `--task "<text>"` / `--file <path>` | What the asset should do, inline or from a UTF-8 file |
| `--engine` | Engine to use (default: `defaults.engine`) |
| `--path <subdir>` | Subdirectory under the type directory |
| `--timeout-ms <ms>` | Override the engine timeout |

```sh
akm proposal new skill release-notes --task "Summarize merged PRs into release notes"
```

#### proposal extract

Experimental. Reads native session files from a harness (`--type claude`,
`codex` or `opencode`, or `--auto` for every available harness), asks the
configured engine for durable insights, and queues them as proposals. `--since`
sets the discovery cutoff (default 24 hours), `--session-id` limits it to one
session, and `--dry-run` shows the candidates without queuing anything.

Run `akm proposal <subcommand> --help` for every flag.

## Other commands

### completions

Print or install a bash completion script.

```sh
akm completions --install
```

Run `akm completions --help` for every flag.

### env

Manage `.env` files stored as `env/<name>` assets. `list` prints key names
only. `env run` passes the file's values to the child process.
`create` and `remove` are Experimental. See [Env and secrets](env-and-secrets.md).

| Subcommand | Purpose |
| --- | --- |
| `list` | List env files across bundles with their key names |
| `run <ref> -- <command>` | Run a command with the file's variables in its environment (`--only`, `--except`, `--clean`, `--inherit`) |
| `path <ref>` | Print the absolute file path |
| `export <ref> --out <file>` | Write `export KEY='value'` lines to a file (mode 0600) |
| `create <name>` | Create an env file (`--from-file`, `--from-stdin`, `--sensitive`, `--path`) |
| `remove <ref>` | Remove an env file (`--yes`) |

```sh
akm env create prod --from-file ./prod.env
akm env run env/prod -- ./deploy.sh
```

Run `akm env <subcommand> --help` for every flag.

### secret

Manage one-value-per-file secrets stored as `secrets/<name>` assets. `list`
prints names only. `secret run` passes one value to the child
process. `set` is Experimental. See [Env and secrets](env-and-secrets.md).

| Subcommand | Purpose |
| --- | --- |
| `list` | List secrets across bundles by name |
| `run <ref> <VAR> -- <command>` | Run a command with the secret in `$VAR` (`--clean`, `--inherit`) |
| `set <ref>` | Create or overwrite a secret; the value comes from stdin, `--from-file` or `--from-env` |

```sh
printf '%s' "$TOKEN" | akm secret set deploy-token
akm secret run secrets/deploy-token DEPLOY_TOKEN -- ./deploy.sh
```

Run `akm secret <subcommand> --help` for every flag.

### task

Schedule recurring commands, prompts and workflows through the OS scheduler
(cron, launchd or schtasks). Task definitions are `tasks/<id>.yml` assets; see
[Tasks](tasks.md).

| Subcommand | Purpose |
| --- | --- |
| `add <id> --schedule <cron>` | Write a task with a target: `--command "<shell>"`, `--prompt "<text>"` or `--workflow <ref>` |
| `enable <ref>` / `disable <ref>` | Turn a task on or off for this host and sync the scheduler |
| `run <id>` | Execute now (what the scheduler calls) |
| `explain <ref>` | Show a task's inputs, target and schedule without running it |
| `validate <path>` | Parse one task file and report what `task sync` would say |
| `history [id]` | Recent runs (`--limit`) |
| `list [query]` | List task assets (same as `akm search --type task`) |
| `sync` | Reconcile enabled tasks with the OS scheduler (`--dry-run`, `--rebind`) |
| `prune` | Preview, or with `--yes` remove, scheduler entries that no longer resolve to a bundle |
| `doctor` | Report the scheduler backend, akm binary path and log directory |

```sh
akm task add nightly-index --schedule "0 3 * * *" --command "akm index"
akm task enable tasks/nightly-index
akm task history nightly-index --limit 5
```

Run `akm task <subcommand> --help` for every flag.

### models

Inspect and customize the model alias table (`fast`, `balanced`, `reasoning`).
See [Configuration](configuration.md#model-map-files).

| Subcommand | Purpose |
| --- | --- |
| `list` | Show the effective alias table and where each entry came from |
| `copy-defaults` | Copy the shipped `models.json` into your config directory (`--overwrite` replaces an existing file) |

```sh
akm models list
```

Run `akm models <subcommand> --help` for every flag.

### hints

Print the agent-facing guide to using akm. The complete guide is the default;
`--detail brief` prints the short one.

```sh
akm hints --detail brief
```

Run `akm hints --help` for every flag.

### help

Print the command overview, help for one command, the agent guide, or a
release's migration notes.

```sh
akm help bundle
akm help agents
akm help migrate 0.9.0
```

`akm help <command>` is the same as `akm <command> --help`. `akm help agents`
prints the short agent guide (`--full` for the complete one).
