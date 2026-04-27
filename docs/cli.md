# CLI Reference

The CLI is called `akm` (Agent Kit Manager). Commands default to structured
JSON at `--detail brief`. Use `--format json|jsonl|text|yaml` and `--detail
brief|normal|full|summary` when you want a different presentation. Errors
include `error` and `hint` fields.

> **Status legend.** This page documents both **pre-release (shipping)** and
> **planned for v1** behaviour. Each command section opens with one of the
> two markers below. Anything marked **Planned for v1** is part of the
> v1.0-frozen surface declared in
> [`docs/technical/v1-architecture-spec.md`](technical/v1-architecture-spec.md)
> §9.4 and is being implemented across milestones 0.7 – 1.0.
>
> - **Status: Pre-release (shipping)** — the command runs today on the
>   current pre-release build. Behaviour described here is what the binary
>   does.
> - **Status: Planned for v1** — the command is declared by the v1
>   architecture spec but is not yet wired up. The shape, flags, and exit
>   behaviour described here are the locked target; the binary will return
>   `usage: command not yet implemented` until the milestone lands.
>
> Sequencing lives in
> [`docs/reviews/v1-implementation-plan.md`](reviews/v1-implementation-plan.md)
> and
> [`docs/reviews/v1-agent-reflection-issues.md`](reviews/v1-agent-reflection-issues.md).

## Global Flags

These flags are accepted by all commands:

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--format` | `json`, `text`, `yaml`, `jsonl` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full`, `summary`, `agent` | `brief` | Output detail level |
| `--for-agent` | boolean | `false` | **Deprecated alias** for `--detail=agent`; kept for one release cycle. Prefer `--detail=agent` |
| `--quiet` / `-q` | boolean | `false` | Suppress stderr warnings |

### `--format jsonl`

Outputs one JSON object per line. For `search` and `registry search`, each hit
is a separate line. For other commands, the entire result is a single line.
Useful for streaming consumption by scripts or agents.

### `--detail=agent` (was `--for-agent`)

Strips output to only action-relevant fields:

- **search**: keeps `name`, `ref`, `type`, `description`, `action`, `score`, `estimatedTokens`
- **show**: keeps `type`, `name`, `description`, `action`, `content`, `template`, `prompt`, `run`, `setup`, `cwd`, `toolPolicy`, `modelHint`, `agent`, `parameters`, `workflowTitle`, `workflowParameters`, `steps`

Prefer `--detail=agent` going forward. The `--for-agent` boolean is kept as
a deprecated alias for one release cycle and will be removed in a future
minor release — see the [v0.5 → v0.6 migration guide](migration/v0.5-to-v0.6.md).

### `--detail summary`

Available for `show` and `search`. Returns a compact view suitable for
capability discovery:

- **show**: `type`, `name`, `description`, `tags`, `parameters`, `workflowTitle`, `action`, `run`, `origin`
- **search**: metadata-only view (no full content), under 200 tokens

## Exit Codes and Error Envelope

Every command exits with one of the following codes:

| Exit code | Meaning | Error class |
| --- | --- | --- |
| 0 | Success | — |
| 1 | Not found or general error | `NotFoundError`, other |
| 2 | Usage / bad input | `UsageError` |
| 78 | Configuration error | `ConfigError` |

On failure, every command emits a JSON error envelope on **stderr** before
exiting; stdout is left empty (or contains only command-specific side-effect
output such as shell snippets from `vault load`):

```json
{"ok": false, "error": "<message>", "hint": "<optional hint>"}
```

The `hint` field is present only when actionable remediation is available (e.g.
`"Run akm add <source> --trust to bypass the audit for this source."`). Agents
should check `ok === false` on the parsed stderr envelope or a non-zero exit
code to detect failure. Scripts can rely on the exit code alone.

## Commands

### init

Create the stash directory structure and persist the working stash path in
config.

```sh
akm init                         # Initialize at the default location
akm init --dir ~/custom-stash    # Initialize at a custom location
akm init --stashDir ~/custom-stash # Legacy alias for --dir
```

Creates one subdirectory per asset type under the stash path — currently
`scripts/`, `skills/`, `commands/`, `agents/`, `knowledge/`, `workflows/`,
`memories/`, `vaults/`, and `wikis/`. See
[technical/filesystem.md](technical/filesystem.md) for config file locations.

### setup

Run the interactive first-run wizard.

```sh
akm setup
```

The wizard lets you choose a stash directory, configure embedding and LLM
providers, review semantic-search assets, review registries, and add stash
sources. When you save, akm writes the config file, initializes the stash
directory, and builds the search index.

### index

Build or refresh the search index.

```sh
akm index          # Incremental (only changed directories)
akm index --full   # Full rebuild
akm index --verbose
```

Returns stats: `totalEntries`, `generatedMetadata`, `directoriesScanned`,
`directoriesSkipped`, `verification`, optional `warnings`, and `timing`
breakdown in milliseconds. Use `--verbose` to print the indexing mode,
semantic-search settings, and phase-by-phase progress to stderr while the
index is being built. Malformed workflow assets are skipped with file-path
warnings instead of aborting the full run.

### info

Show system capabilities, configuration, and index state.

```sh
akm info
```

Returns a JSON object with:

| Field | Description |
| --- | --- |
| `version` | Current akm version |
| `assetTypes` | List of recognized asset types |
| `searchModes` | Active search modes (`fts`, optionally `semantic` and `hybrid`) |
| `semanticSearch` | Semantic search status: `mode`, `status`, and optional `reason`/`message` |
| `registries` | Configured registries |
| `sourceProviders` | Configured sources (filesystem, git, website, npm) |
| `indexStats` | Index stats: `entryCount`, `lastBuiltAt`, `hasEmbeddings`, `vecAvailable` |

`semanticSearch.status` values:
- `"ready-vec"` — native sqlite-vec extension active (fastest)
- `"ready-js"` — pure JS fallback active (correct but slower at scale)
- `"pending"` — not yet initialized (run `akm index` to set up)
- `"blocked"` — setup failed (see `reason` and `message` fields)
- `"disabled"` — semantic search is turned off in config

Use `akm info` to verify that semantic search is working after setup.

### search

Search stash assets, registry stashes, or both.

```sh
akm search "deploy"
akm search "deploy" --type script --limit 10
akm search "lint" --source registry
akm search "docker" --source both --detail full

# Multi-tenant scope filtering (0.7.0+):
akm search "deploy" --filter user=alice
akm search "deploy" --filter user=alice --filter agent=claude

# Include proposal-queue entries (v1 spec §4.2):
akm search "deploy" --include-proposed
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `workflow`, `memory`, `script`, `vault`, `any` | `any` | Filter by asset type |
| `--limit` | number | `20` | Maximum results |
| `--source` | `stash`, `registry`, `both` | `stash` | Where to search (`local` is an alias for `stash`) |
| `--filter` | `<key>=<value>` | _(none)_ | Scope filter — repeatable. Valid keys: `user`, `agent`, `run`, `channel`. Example: `--filter user=alice --filter channel=ops`. Narrows the result set; ranking is unchanged. |
| `--include-proposed` | flag | `false` | Include entries with `quality: "proposed"` in the result set. Default search excludes them; `generated` and `curated` quality entries are always included. Unknown quality values warn once and remain searchable. |
| `--format` | `json`, `text`, `yaml`, `jsonl` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full`, `summary` | `brief` | Output detail level (`summary` returns metadata-only, under 200 tokens) |

`--filter` flags AND-join: every supplied key must match the entry's
`scope` for the entry to appear in the result set. Entries without any scope
are excluded as soon as a filter is supplied. With no `--filter` (the
default), unfiltered queries continue to surface all entries — including
legacy memories that pre-date the scope contract.

Local hits include a `ref` handle for use with `akm show`. Key fields in
search results:

- **`ref`** -- The asset handle to pass to `akm show` (e.g. `script:deploy.sh`)
- **`name`** -- The asset's filename or identifier
- **`origin`** -- The source stash (e.g. `npm:@scope/pkg`), present only for managed source assets
- **`id`** -- Registry-level stash identifier (registry hits only)

The default brief shape is intentionally small. The exact field set per
detail level matches `src/output/shapes.ts`:

| Level | Local stash hits | Registry hits |
| --- | --- | --- |
| `brief` (default) | `type`, `name`, `action`, `estimatedTokens` | `name`, `installRef`, `score` |
| `normal` | adds `description`, `score`, optional `warnings`, optional `quality` | adds `description`, `action`, `installRef`, `score`, and optional `warnings` |
| `full` | full hit object (includes `ref`, `origin`, `tags`, `whyMatched`, optional `warnings`, optional `quality`, timings, stash metadata) | full hit object |
| `summary` | metadata-only view (no content), under 200 tokens | — |
| `agent` (preferred since 0.6.0; `--for-agent` is the deprecated alias) | `name`, `ref`, `type`, `description`, `action`, `score`, `estimatedTokens` | — |

The legacy registry boolean `curated` is removed in v1 (spec §4.2). Renderers
surface an optional `warnings: string[]` field on hits when a provider has
non-fatal issues to report; the field is omitted otherwise. Per spec §4.2,
populating `warnings` does not affect ranking.

> **Score ranges differ between local and registry hits.** Local
> `SearchHit.score` is the locked v1 contract value in `[0, 1]`, higher = better
> (CLAUDE.md and v1-architecture-spec §4). Registry `RegistrySearchHit.score`
> is registry-native: provider-defined and may exceed `1` (the bundled
> `static-index` provider can emit values up to ~1.85 from `scoreStash()`).
> Use registry scores only for ranking within a single registry — do **not**
> compare them numerically against local `SearchHit.score` values or across
> registries with different scoring formulas. See
> `docs/technical/v1-architecture-spec.md` §4 for the type-level distinction.

If you want a `ref` handle without the rest of the `full` payload, use
`--detail=agent`.

### curate

Curate the best matching assets for a task or prompt by combining search with a
compact, follow-up-friendly summary.

```sh
akm curate "plan a release"
akm curate "deploy a Bun app" --limit 3
akm curate "review an architecture proposal" --type skill
akm curate "learn the release workflow" --source both --format text
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `workflow`, `memory`, `script`, `vault`, `any` | `any` | Filter curated results by asset type |
| `--limit` | number | `4` | Maximum curated results |
| `--source` | `stash`, `registry`, `both` | `stash` | Where to search before curating |

`akm curate` selects high-signal results, prefers one strong match per asset
type by default, and includes direct follow-up commands such as `akm show <ref>`
or `akm add <stash>` so you can immediately inspect or install what it found.
Use `--type workflow` when you want curated step-by-step procedures instead of
individual scripts, skills, or docs.

### show

Display an asset by ref. Knowledge assets support view modes as positional
arguments after the ref.

```sh
akm show script:deploy.sh
akm show skill:code-review
akm show agent:architect
akm show command:release
akm show workflow:ship-release
akm show knowledge:guide toc
akm show knowledge:guide section "Authentication"
akm show knowledge:guide lines 10 30
akm show knowledge:guide frontmatter

# Multi-tenant scope filtering (0.7.0+):
akm show memory:retro --scope user=alice
akm show memory:retro --scope user=alice --scope agent=claude
```

`--scope` accepts the same `<key>=<value>` shape as `akm search --filter`
(repeatable; valid keys: `user`, `agent`, `run`, `channel`). When supplied,
the resolved asset's frontmatter `scope_*` keys must match every supplied
filter. A mismatch (or absent scope) returns `NotFoundError` so the caller
cannot accidentally read out-of-scope content.

The default `show` JSON includes the asset body when applicable. Use
`--detail brief` for a reduced metadata-first view without
`content`/`template`/`prompt`; `--detail full` adds verbose metadata such as
`schemaVersion`, `path`, `editable`, and `editHint`; `--detail summary`
returns a compact view with only `type`, `name`, `description`, `tags`,
`parameters`, `workflowTitle`, `action`, `run`, `origin`, `keys`, and
`comments`.

Returns type-specific payloads:

| Type | Key fields |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description` |
| agent | `prompt`, `description`, `modelHint` |
| knowledge | `content` with view modes: `full`, `toc`, `frontmatter`, `section`, `lines` |
| workflow | `workflowTitle`, `workflowParameters`, `steps` |
| memory | `content` |
| vault | `keys`, `comments` |

Assets from non-writable sources (git clones, npm packages, websites) return
`editable: false`. `akm show` queries the local FTS5 index directly — there
is no remote-provider fallback. If the ref points to a package origin that
is not installed, `akm show` returns guidance to run `akm add <origin>` first.

`akm show wiki:<name>` returns the same summary as `akm wiki show <name>` —
path, description from `schema.md`, page and raw counts, and the last 3
`log.md` entries.

### workflow

Author, inspect, and execute structured workflow assets.

```sh
akm workflow template
akm workflow create ship-release
akm workflow create ship-release --from ./ship-release.md
akm workflow validate workflow:ship-release    # Validate a workflow ref
akm workflow validate ./workflows/release.md   # Validate a workflow file
akm workflow start workflow:ship-release --params '{"version":"1.2.3"}'
akm workflow next workflow:ship-release
akm workflow next workflow:ship-release --params '{"version":"1.2.3"}'
akm workflow complete <run-id> --step validate --state completed --notes "Inputs verified"
akm workflow status <run-id>
akm workflow status workflow:ship-release
akm workflow resume <run-id>
akm workflow list --active
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `template` | Print a valid starter workflow markdown document |
| `create <name>` | Validate and write a workflow under `workflows/<name>.md` |
| `validate <ref\|path>` | Validate a workflow markdown file or ref and print any errors |
| `start <ref>` | Create a new persisted workflow run |
| `next <run-id\|ref>` | Return the current actionable step; resumes active runs and starts a new run when the ref has no active run |
| `complete <run-id> --step <step-id>` | Update the current pending step on an active run and persist status, notes, and evidence |
| `status <run-id\|ref>` | Show the full run state, including all step statuses |
| `list` | List workflow runs (optionally filtered by `--ref` and `--active`) |
| `resume <run-id>` | Flip a `blocked` or `failed` run back to `active`. Completed runs cannot be resumed |

#### workflow create

```sh
akm workflow create ship-release
akm workflow create ship-release --from ./ship-release.md
akm workflow create ship-release --from ./ship-release.md --force
akm workflow create ship-release --force --reset
```

`--force` requires either `--from <file>` (replace from a source file) or
`--reset` (explicitly acknowledge you are overwriting in place). Without one of
these, `--force` is rejected to prevent silent template overwrites.

Workflow names must match `^[a-z0-9][a-z0-9._/-]*$` — lowercase letters and
digits, hyphens, dots, underscores, and forward slashes allowed; must start
with a lowercase letter or digit. Forward slashes are supported for
hierarchical names (e.g. `release/ship`).

#### workflow next

```sh
akm workflow next workflow:ship-release
akm workflow next <run-id>
akm workflow next workflow:ship-release --params '{"version":"1.2.3"}'
```

When multiple active runs exist for the same workflow ref, `next` selects the
**most-recently-updated** run.

When no active run exists, `next` auto-starts a new run for the workflow ref.
Pass `--params` to supply parameters for the auto-started run. If an active run
already exists, `--params` is rejected with a usage error.

Response shape:

| Field | When present |
| --- | --- |
| `step` | The current actionable step object, or `null` when the run is complete |
| `done` | `true` when the resolved run is already complete |
| `autoStarted` | `true` when `next` auto-started a new run (no active run existed) |
| `run` | The run object |

When `done: true` is present, `step` is `null` and no further action is needed
for this run. Start a new run with `akm workflow start` if required.

**Snapshot isolation:** workflow runs snapshot their step list when started.
Edits to the source workflow file after a run has started do not affect
in-flight runs. The run always follows the steps that were defined at start
time.

#### workflow complete

```sh
akm workflow complete <run-id> --step <step-id>
akm workflow complete <run-id> --step <step-id> --state completed --notes "Done"
akm workflow complete <run-id> --step <step-id> --state skipped
```

`--state` defaults to `completed` when omitted. Accepted values: `completed`,
`skipped`, `failed`.

#### workflow status

```sh
akm workflow status <run-id>
akm workflow status workflow:ship-release
```

Accepts either a run-id or a workflow ref. When given a workflow ref, resolves
to the most-recently-updated run for that ref.

#### workflow resume

```sh
akm workflow resume <run-id>
```

Flips a `blocked` or `failed` run back to `active`. Completed runs cannot be
resumed. Use `workflow list` to find runs by status.

Workflow markdown contract:

- Optional frontmatter only supports `description`, `tags`, and `params`.
- `tags` may be a string or an array of non-empty strings.
- `params` must be a mapping of parameter names to non-empty string descriptions.
- The document must contain exactly one `# Workflow: <title>` heading.
- Each step must be a `## Step: <title>` section.
- Each step must include exactly one `Step ID: <id>` line. IDs must start with a letter or number and then use only letters, numbers, `.`, `_`, or `-`.
- Each step must include exactly one `### Instructions` section with non-empty text.
- `### Completion Criteria` is optional, but when present it must contain at least one non-empty item. Each non-empty line is treated as one criterion, with an optional leading `-` or `*` removed.
- No other frontmatter keys, top-level headings, or step subsections are accepted.

### How `add` works

`akm add` infers what to do from the input:

| Input | What happens |
| --- | --- |
| `akm add ~/.claude/skills` | Registers a local directory as a `filesystem` source |
| `akm add github:owner/repo` | Clones the repo into akm's cache as a `git` source |
| `akm add @scope/stash` | Installs the npm package as a `git`/`npm` source |
| `akm add https://docs.example.com` | Crawls and caches a website as a `website` source |
| `akm registry add <url>` | Adds a discovery registry (separate concept) |

`akm add` also supports a per-install audit bypass when you intentionally trust
the source:

```sh
akm add github:owner/private-stash --trust
```

Use `--trust` only for one-off installs you have manually reviewed. It does not
persist trust in config. Note: `--trust` has no effect on local directory
sources — the audit is not run for local paths.

HTTP(S) URLs pointing to known git hosts (GitHub, GitLab, Bitbucket, Codeberg,
SourceHut) or ending in `.git` are treated as git sources. All other HTTP(S)
URLs are treated as website sources.

### add

Add a source — a local directory, npm package, GitHub repo, git URL, or website.

```sh
akm add ~/.claude/skills              # Local directory
akm add @scope/stash                    # npm package
akm add npm:@scope/stash@latest         # npm with version
akm add github:owner/repo#v1.2.3     # GitHub with tag
akm add https://github.com/owner/repo
akm add git+https://gitlab.com/org/stash
akm add ./path/to/local/stash
akm add github:andrewyng/context-hub --name context-hub  # context-hub as a git stash
akm add https://docs.example.com --name docs              # Website
akm add https://docs.example.com --max-pages 100 --max-depth 5
```

| Flag | Description |
| --- | --- |
| `--name` | Human-friendly name for the source |
| `--provider` | Provider type (e.g. `website`, `npm`). Required for URL sources where inference would be ambiguous |
| `--writable` | Mark a git source as writable so `akm save` also pushes (default: false) |
| `--options` | Provider options as JSON (e.g. `'{"ref":"main"}'`) |
| `--type` | Override asset type for all files in this source (currently supports: `wiki`) |
| `--trust` | Bypass install-audit blocking for this add invocation only |
| `--max-pages` | Maximum pages to crawl for website sources (default: 50) |
| `--max-depth` | Maximum crawl depth for website sources (default: 3) |

#### Website sources

When the input is an HTTP(S) URL that isn't a known git host, akm treats it as
a website source. It crawls the site breadth-first from the given URL, converts
each page to markdown, and stores the results as knowledge assets with the URL
path hierarchy preserved.

```sh
akm add https://www.agentic-patterns.com/ --name agent-patterns
akm add https://docs.example.com/guide --name guide --max-pages 200
```

Pages are cached locally and refreshed every 12 hours. The crawl stays within
the same origin (hostname) and skips static assets (images, CSS, JS, etc.).

Use `--max-pages` and `--max-depth` to control how many pages are fetched and
how many link levels deep the crawler goes. These values are persisted in your
config so subsequent re-indexes use the same limits.

See [registry.md](registry.md) for the full install flow for managed sources.

> **0.6.0 note:** the pre-0.6.0 `akm add context-hub` convenience alias and
> the `akm enable context-hub` / `akm disable context-hub` commands were
> removed. Add it explicitly as a git stash:
> `akm add github:andrewyng/context-hub --name context-hub`. The legacy
> stash *type* string `"context-hub"` in existing configs still normalizes
> to `"git"` at load time, so you don't need to edit your config files.

### list

Show all sources — local directories, managed packages, and remote providers.

```sh
akm list                            # All sources
akm list --kind local               # Only local directories
akm list --kind managed             # Only managed packages
akm list --kind remote              # Only remote providers
akm list --kind local,remote        # Multiple kinds
```

| Flag | Description |
| --- | --- |
| `--kind` | Filter by source kind: `local`, `managed`, `remote` (comma-separated) |

### remove

Remove a source by id, ref, path, URL, or name and reindex.

```sh
akm remove npm:@scope/stash           # Managed source by id
akm remove owner/repo               # Managed source by ref
akm remove ~/.claude/skills         # Local source by path
akm remove my-provider              # Any source by name
```

### update

Update one or all managed sources to the latest available version. Local and
remote sources are not updatable — akm explains why if you target one.

```sh
akm update npm:@scope/stash
akm update --all
akm update --all --force   # Force fresh download even if version is unchanged
```

| Flag | Description |
| --- | --- |
| `--all` | Update all managed sources |
| `--force` | Delete cached extraction before re-downloading |

Reports per-entry change flags: `changed.version`, `changed.revision`,
`changed.any`.

### upgrade

Upgrade `akm` itself to the latest release. This is for users who installed
`akm` as a standalone binary. For npm installs, it prints guidance instead.

```sh
akm upgrade              # Download and replace the running binary
akm upgrade --check      # Check for updates without installing
akm upgrade --force      # Force upgrade even if already on latest
```

| Flag | Description |
| --- | --- |
| `--check` | Check for updates without installing |
| `--force` | Force upgrade even if on latest version |
| `--skip-checksum` | Skip checksum verification during upgrade (not recommended) |

### clone

Copy an asset from any source into the working stash (or a custom
destination) for editing.

```sh
akm clone script:deploy.sh
akm clone "npm:@scope/pkg//script:deploy.sh"
akm clone script:deploy.sh --name my-deploy.sh
akm clone script:deploy.sh --force
akm clone script:deploy.sh --dest ./project/.claude
akm clone "npm:@scope/pkg//script:deploy.sh" --dest /tmp/preview
```

| Flag | Description |
| --- | --- |
| `--name` | New name for the cloned asset |
| `--force` | Overwrite if the asset already exists at the destination |
| `--dest` | Destination directory (default: working stash). The type subdirectory (`scripts/`, `skills/`, etc.) is appended automatically |

Skills (directories) are copied recursively. Other types copy a single file.

**Remote clone:** When the origin in the ref points to a package that is not
installed locally (e.g. an npm package or local path not in your stash
sources), akm fetches it to the cache automatically and extracts the
requested asset. The package is **not** registered as a managed source --
use `akm add` for that.

```sh
# Clone a single script from a remote package without installing the full stash
akm clone "npm:@scope/pkg//script:deploy.sh"

# Clone from a local directory that isn't configured as a search path
akm clone "/path/to/stash//skill:code-review" --dest ./project/.claude
```

When `--dest` is provided, the working stash (`AKM_STASH_DIR`) is not
required. This makes clone usable in CI or fresh environments without
running `akm init` first.

### save

Stage and commit local changes in a git-backed stash. If the stash has a
remote configured and is marked `writable: true`, the commit is also pushed.

```sh
akm save                            # Save primary stash (auto timestamp message)
akm save -m "Add deploy skill"     # Save with custom message
akm save --format json             # Explicit format (both --format json and --format=json work)
akm save my-skills                  # Save a named writable git stash
akm save my-skills -m "Update"     # Save named stash with message
```

| Argument / Flag | Description |
| --- | --- |
| `[name]` | Optional stash name. Defaults to the primary stash |
| `-m`, `--message` | Commit message. Defaults to `akm save <timestamp>` |
| `--format` | Output format (`json`, `text`, `yaml`). Both `--format json` and `--format=json` are accepted |

**Behaviour by repo state:**

| State | Result |
| --- | --- |
| Not a git repo | Exit 0, `skipped: true` in JSON output — no error |
| Git repo, no remote | Stage and commit only |
| Git repo, has remote, not writable | Stage and commit only |
| Git repo, has remote, `writable: true` | Stage, commit, and push |

**Primary stash writable config:**

To make the primary stash push on save, set `writable: true` at the root of
your config file (`~/.config/akm/config.json` or the path shown by
`akm config path`):

```json
{
  "stashDir": "~/akm",
  "writable": true
}
```

When `writable: true` is set and the primary stash has a git remote configured,
`akm save` will stage, commit, and push.

When `akm init` successfully initializes the default stash as a local git repo
(requires `git` to be installed), `akm save` will commit there safely without
pushing. If git is unavailable, the stash will not be a git repo and save will
return a skipped result.

To make a named remote git stash writable, pass `--writable` when adding it:

```sh
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
```

### remember

Record a memory. This writes a markdown file into `memories/` in the configured
write target and returns the resulting ref.

**Write target resolution:** the destination is the working stash (`stashDir`)
unless `defaultWriteTarget` is set in config, which overrides it to a named
source. An explicit `--target <name>` flag overrides both. The full order is
`--target` → `defaultWriteTarget` → `stashDir` → `ConfigError`. See
[Configuration](configuration.md#defaultwritetarget) for details.

```sh
akm remember "Deployment needs VPN access"
akm remember --name release-retro < notes.md
akm remember "Pair with ops before rotating prod secrets" --name ops/prod-secrets

# With structured frontmatter (0.6.0+):
akm remember "VPN required for staging deploys" \
  --tag ops --tag networking \
  --expires 90d \
  --source "skill:deploy"

# Opt-in heuristic tagging — derives `code`, `source`, `observed_at`, `subjective`:
akm remember "Found this snippet: \`curl -fsSL ... | bash\`" --tag ops --auto

# Opt-in LLM enrichment (requires configured LLM endpoint; fails soft):
akm remember "Long meeting notes..." --enrich

# Multi-tenant / multi-agent scope (0.7.0+):
akm remember "Use staging cluster for blue-green" \
  --user alice --agent claude --run run-42 --channel "#ops"
```

| Flag | Description |
| --- | --- |
| `--name` | Optional memory name. Defaults to a slug derived from the content |
| `--force` | Overwrite an existing memory with the same name |
| `--tag <v>` | Tag to attach to the memory. Repeatable: `--tag foo --tag bar` |
| `--expires <dur>` | Expiry shorthand (`30d`, `12h`, `6m`). Resolved to an ISO date |
| `--source <s>` | Free-form source reference — URL, asset ref, file path, or any string |
| `--auto` | Apply heuristic tagging from the body (opt-in, zero-latency, pure TS) |
| `--enrich` | Call the configured LLM for tag/description proposals (opt-in, 10s timeout, fails soft) |
| `--user <id>` | Scope this memory to a user id. Persisted as the canonical `scope_user` frontmatter key. |
| `--agent <id>` | Scope this memory to an agent id. Persisted as `scope_agent`. |
| `--run <id>` | Scope this memory to a run id. Persisted as `scope_run`. |
| `--channel <name>` | Scope this memory to a channel name. Persisted as `scope_channel`. |
| `--target <name>` | Override the write destination. Accepts a source name from your config; falls back to `defaultWriteTarget` then the working stash. |

Pass the content as a quoted positional argument for short notes, or pipe
markdown into stdin for longer memories.

**Zero-flag form** (`akm remember "body"`) writes a bare memory with no
frontmatter — existing agent scripts keep working unchanged. Any use of
`--tag` / `--expires` / `--source` / `--auto` / `--enrich` triggers a
required-field check: if `tags` cannot be derived, the command rejects
*before* writing the file, so you never end up with an orphan.

**Scope flags** (`--user`, `--agent`, `--run`, `--channel`) are independent
of the tag-required check. They write the four canonical top-level
frontmatter keys (`scope_user`, `scope_agent`, `scope_run`, `scope_channel`)
and a memory with only scope flags is valid (no tags required). Scope is the
multi-tenant / multi-agent contract; the same shape is read back by
`akm search --filter` and `akm show --scope`. See
[Configuration → Memory scope](configuration.md#memory-scope) for the
frontmatter schema and round-trip rules.

### import

Import a knowledge document. This writes a markdown file into `knowledge/` in
the configured write target and returns the resulting ref.

**Write target resolution:** the destination is the working stash (`stashDir`)
unless `defaultWriteTarget` is set in config, which overrides it to a named
source. An explicit `--target <name>` flag overrides both. The full order is
`--target` → `defaultWriteTarget` → `stashDir` → `ConfigError`. See
[Configuration](configuration.md#defaultwritetarget) for details.

```sh
akm import ./docs/auth-flow.md
akm import ./notes/release.txt --name release-checklist
akm import - --name scratch-notes < notes.md
```

| Flag | Description |
| --- | --- |
| `--name` | Optional knowledge name. Defaults to the source filename or a slug from stdin content |
| `--force` | Overwrite an existing knowledge document with the same name |
| `--target <name>` | Override the write destination. Accepts a source name from your config; falls back to `defaultWriteTarget` then the working stash. |

The source must be a readable file path, or `-` to read the document from
stdin.

### feedback

Record positive or negative feedback for any indexed stash asset. Feedback
influences utility scores during the next index run, causing highly-rated
assets to rank higher in search results over time.

```sh
akm feedback script:deploy.sh --positive
akm feedback agent:reviewer --negative
akm feedback memory:deployment-notes --positive
akm feedback vault:prod --positive
akm feedback skill:code-review --positive --note "Worked perfectly for PR reviews"
```

| Flag | Description |
| --- | --- |
| `--positive` | Record positive feedback (use when an asset was helpful) |
| `--negative` | Record negative feedback (use when an asset was not useful) |
| `--note` | Optional text note to attach to the feedback event |

Specify exactly one of `--positive` or `--negative`. The ref must already be
present in the current local index.

### history

Surface per-asset state changes recorded in the local `usage_events` log
(searches, shows, feedback, and any other mutations the indexer has captured).
Use it for audit trails, lifecycle inspection, and debugging utility-score
shifts without re-deriving an audit log from raw SQL.

`history` is the *per-asset state-change* view. It complements the realtime
events stream proposed in [#204](https://github.com/itlackey/agentikit/issues/204):
events emit at the moment a mutation happens; `history` is the durable replay
of what was recorded for an asset (or for the whole stash).

```sh
akm history                                    # Stash-wide, oldest first
akm history --ref skill:deploy                 # Filter to one asset ref
akm history --since 2026-04-01T00:00:00Z       # Filter by ISO timestamp
akm history --since 1717200000000              # Filter by epoch ms
akm history --ref skill:deploy --format jsonl  # One entry per line
akm history --format text                      # Human-readable trail
```

| Flag | Description |
| --- | --- |
| `--ref` | Filter to a single asset ref (`[origin//]type:name`). Omit for stash-wide history. |
| `--since` | Lower bound on `createdAt`. Accepts ISO 8601, `YYYY-MM-DD`, or epoch milliseconds. |
| `--format` | Standard global flag. `text` renders a chronological trail; `json`/`jsonl`/`yaml` emit the envelope. |

Output envelope (JSON):

```json
{
  "schemaVersion": 1,
  "ref": "skill:deploy",
  "since": "2026-04-01 00:00:00",
  "totalCount": 3,
  "entries": [
    {
      "id": 17,
      "eventType": "feedback",
      "ref": "skill:deploy",
      "entryId": 42,
      "query": null,
      "signal": "positive",
      "metadata": null,
      "createdAt": "2026-04-12 14:03:21"
    }
  ],
  "warnings": []
}
```

`schemaVersion` is always `1` for this release. `ref` and `since` are echoed
back only when the corresponding flags were supplied. `totalCount` matches
`entries.length` (no server-side pagination yet). `warnings` is omitted when
empty. Entries are returned in chronological order (oldest first).

If the stash has never been indexed, the `usage_events` schema is created
on demand and the command returns an empty `entries` array rather than
erroring.

### events

Append-only realtime events stream (#204). Every mutating CLI verb appends
a JSON line to `<cacheDir>/events.jsonl`; `akm events list` reads it and
`akm events tail` follows it via polling.

```sh
akm events list                                   # All events, oldest first
akm events list --type feedback                   # Filter by event type
akm events list --ref skill:deploy                # Filter by asset ref
akm events list --since 2026-04-01T00:00:00Z      # ISO timestamp
akm events list --since '@offset:12345'           # Resume from a byte cursor
akm events tail --max-events 10                   # Follow until 10 events
akm events tail --format jsonl                    # Stream as JSONL
```

| Flag | Description |
| --- | --- |
| `--since` | Lower bound. Accepts ISO 8601, epoch ms, or `@offset:<bytes>` for a durable byte-cursor that survives across processes. |
| `--type` | Filter by event type (`add`, `remove`, `update`, `remember`, `import`, `save`, `feedback`). |
| `--ref` | Filter by asset ref (`[origin//]type:name`). |
| `--interval-ms` | (`tail` only) Polling interval. Default `75`. |
| `--max-events` | (`tail` only) Stop after this many events. |
| `--max-duration-ms` | (`tail` only) Stop after this many ms. |

The list/tail envelope echoes a `nextOffset` byte cursor — persist it and
pass it back as `--since '@offset:<nextOffset>'` to resume from exactly
where you stopped, with no duplicates and no losses, even across process
boundaries.

Streaming output (`--format jsonl` / `--format text`) emits each event as
a single line on stdout, then a trailer:

- `--format jsonl` ends with a final discriminated row on stdout:
  `{"_kind":"trailer","schemaVersion":1,"nextOffset":<bytes>,"totalCount":<n>,"reason":"signal|maxEvents|maxDuration"}`.
- `--format text` writes the trailer to stderr to keep stdout pristine for
  line-oriented parsers: `[events-tail] reason=<r> nextOffset=<n> total=<t>`.

#### Environment isolation

`events.jsonl` lives at `<cacheDir>/events.jsonl`, where `<cacheDir>` is
derived from `XDG_CACHE_HOME` at the time of each call. Two processes with
different inherited `XDG_CACHE_HOME` values write to different files; if
the events stream is being used as a shared bus between cooperating
processes, set `XDG_CACHE_HOME` consistently across them. This is the same
env-isolation behaviour the rest of akm uses for config, caches, and
indexes.

### registry

Manage stash registries. The `registry` command has four subcommands:

#### registry list

List all configured registries and their status.

```sh
akm registry list
```

#### registry add

Add a third-party registry by URL.

```sh
akm registry add https://example.com/registry/index.json
akm registry add https://example.com/registry/index.json --name my-team
akm registry add https://skills.sh --name skills.sh --provider skills-sh
```

| Flag | Description |
| --- | --- |
| `--name` | Human-friendly label for the registry |
| `--provider` | Provider type (e.g. `static-index`, `skills-sh`). Default: `static-index` |
| `--options` | Provider-specific options as JSON (e.g. `'{"apiKey":"key"}'`) |
| `--allow-insecure` | Allow a plain HTTP registry URL (rejected by default) |

Duplicate URLs are rejected.

#### registry remove

Remove a registry by URL or name.

```sh
akm registry remove https://example.com/registry/index.json
akm registry remove my-team
```

#### registry build-index

Generate a v2 registry index from npm/GitHub discovery and manual entries.

```sh
akm registry build-index
akm registry build-index --out dist/index.json
```

| Flag | Description |
| --- | --- |
| `--out` | Output path for the generated index (default: `./index.json`) |
| `--manual` | Path to a JSON file with manual stash entries |
| `--npm-registry` | Override npm registry base URL |
| `--github-api` | Override GitHub API base URL |

#### registry search

Search all enabled registries for stashes.

```sh
akm registry search "deploy"
akm registry search "code review" --assets
akm registry search "docker" --limit 5
```

| Flag | Description |
| --- | --- |
| `--limit` | Maximum number of results |
| `--assets` | Include asset-level results from v2 registry indexes |

### config

Read and write configuration.

```sh
akm config                          # Show current config
akm config list                     # List current config
akm config get output.format        # Read one key
akm config set output.detail full   # Set one key
akm config unset llm                # Remove an optional key
akm config path                     # Print path to config file
akm config path --all               # Print all config-related paths
```

See [configuration.md](configuration.md) for details.

### help

Print focused help topics. Currently the only subcommand is `migrate`, which
prints release notes and migration guidance for a specific version so you can
review what changed — and what to do about it — without leaving the terminal.

```sh
akm help migrate 0.6.0         # Notes for a specific release
akm help migrate v0.6.0        # v-prefix accepted
akm help migrate v0.6.0-rc1    # Prereleases normalize to the stable note
akm help migrate latest        # Resolve against the most recent CHANGELOG entry
```

Migration notes live as one markdown file per release in
[`docs/migration/release-notes/`](migration/release-notes/). Adding notes for a
future version is a one-file drop — no code edit required. Requesting an
unknown version prints the list of bundled notes so you can pick one that
exists. See [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md#shipping-a-release--migration-notes)
for the per-release workflow.

### hints

Print agent-facing instructions for using `akm`. Add this output to your
`AGENTS.md`, `CLAUDE.md`, or system prompt so your agent knows how to use
the CLI.

```sh
akm hints
```

### vault

Manage `.env`-backed secret vaults. Each vault is a mode-0600 file stored
under `vaults/` in your stash. The key security property: **vault values never
appear in structured output**. `list` and `show` return key names and comments
only.

```sh
akm vault list
akm vault list vault:prod
akm vault show vault:prod
akm vault create prod
akm vault set vault:prod DATABASE_URL https://db.example.com
akm vault set vault:prod DATABASE_URL=https://db.example.com
akm vault set vault:prod API_KEY=abc123 --comment "Rotate every 90 days"
akm vault unset vault:prod DATABASE_URL
eval "$(akm vault load vault:prod)"
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `list` | List all vaults with key counts |
| `list <ref>` | List keys and comments in one vault (no values) |
| `show <ref>` | Alias for `list <ref>` — same output |
| `create <name>` | Create an empty `.env` vault (mode 0600). No-op if it already exists |
| `set <ref> <KEY> <VALUE>` | Set a key in the vault |
| `unset <ref> <KEY>` | Remove a key from the vault |
| `load <ref>` | Emit a shell snippet that loads vault values into the current shell |

#### vault list

```sh
akm vault list                      # All vaults: name + keyCount
akm vault list vault:prod           # Keys + comments for vault:prod (no values)
```

The top-level `list` returns one entry per vault with `name` and `keyCount`.
The per-vault `list <ref>` returns an array of `{key, comment}` objects —
values are never included.

#### vault show

```sh
akm vault show vault:prod
```

An alias for `vault list <ref>`. Returns the same `{key, comment}` array as
`vault list vault:prod`.

#### vault create

```sh
akm vault create prod
```

Creates `vaults/prod.env` with mode 0600. If the vault already exists, the
command exits 0 and reports `created: false` — it never overwrites.

#### vault set

```sh
akm vault set vault:prod DATABASE_URL https://db.example.com
akm vault set vault:prod DATABASE_URL=https://db.example.com
akm vault set vault:prod API_KEY=abc123 --comment "Rotate every 90 days"
```

Both the three-positional form (`<ref> <KEY> <VALUE>`) and the combined
`KEY=VALUE` form are accepted. The `=` split happens on the first `=` so
values may themselves contain `=`.

`--comment "<text>"` attaches a `# <text>` comment line immediately above the
key in the `.env` file. If the key already exists and is being updated, the
preceding comment is also updated. Existing unrelated comments are preserved.

| Flag | Description |
| --- | --- |
| `--comment` | Attach a comment line above the key |

#### vault unset

```sh
akm vault unset vault:prod DATABASE_URL
```

Removes the key and its associated comment from the vault. Exits 0 whether or
not the key existed.

#### vault load

```sh
eval "$(akm vault load vault:prod)"
```

Emits a shell snippet that loads vault values into the current shell session.
The implementation writes a mode-0600 temp file, sources it, then immediately
removes it. **Values never appear on akm's stdout** — the snippet is the only
output, and the values are loaded directly into the shell environment.

Use `eval "$(akm vault load vault:<name>)"` in shell scripts or agent tool
calls to hydrate the environment before running commands that need those
secrets.

### wiki

Manage multiple markdown wikis following the Karpathy LLM-wiki pattern.
Each wiki lives at `<stashDir>/wikis/<name>/` and contains `schema.md`
(the per-wiki rulebook), `index.md` (a regenerable catalog), `log.md`
(append-only activity log), a `raw/` directory of immutable ingested
sources, and any number of agent-authored pages. See
[wikis.md](wikis.md) for the full guide.

Design principle: **akm surfaces, the agent writes.** akm owns lifecycle,
raw-slug generation, structural lint, and index regeneration. Page edits
use the agent's native `Read` / `Write` / `Edit` tools. No LLM calls are
made anywhere in the wiki surface.

```sh
akm wiki create research
akm wiki list
akm wiki show research
echo "# Attention Is All You Need" | akm wiki stash research - --as attention
akm wiki pages research
akm wiki search research "attention"
akm wiki lint research
akm wiki ingest research               # prints the workflow; does nothing else
akm wiki remove research --force       # preserves raw/ by default
akm wiki remove research --force --with-sources
```

Subcommands:

| Subcommand | Description |
| --- | --- |
| `create <name>` | Scaffold `wikis/<name>/` with empty `schema.md`, `index.md`, `log.md`, and `raw/` |
| `register <name> <path-or-repo>` | Register an existing directory or repo as a first-class wiki without copying it |
| `list` | List wikis with page and raw counts plus last-modified timestamps |
| `show <name>` | Path, description (from `schema.md`), counts, and the last 3 `log.md` entries |
| `remove <name>` | Delete pages + schema + index + log. Preserves `raw/` unless `--with-sources`. Requires `--force`. External wikis are unregistered without deleting source files |
| `pages <name>` | List page refs + frontmatter descriptions (excludes `schema.md`, `index.md`, `log.md`, `raw/`) |
| `search <name> <query>` | Scope-filtered search over wiki pages — equivalent to `akm search <query> --type wiki` filtered to one wiki. Excludes `raw/`, `schema.md`, `index.md`, and `log.md` |
| `stash <name> <source>` | Copy `source` into `wikis/<name>/raw/<slug>.md`. Source is a file path or `-` for stdin. `--as <slug>` overrides the derived slug. Never overwrites |
| `lint <name>` | Deterministic structural checks (no LLM): orphans, broken xrefs, missing descriptions, uncited raws, stale index, broken sources |
| `ingest <name>` | Print the step-by-step ingest workflow for the named wiki. Does not perform any ingest |

Wiki names must match `^[a-z0-9][a-z0-9-]*$` — lowercase letters and digits
only; must start with a lowercase letter or digit.

`akm add --type wiki --name <name> <path-or-repo>` is a shortcut to
`akm wiki register <name> <path-or-repo>`.

**Side effect:** `akm index` regenerates each wiki's `index.md` as part of
its normal stash walk — there is no separate `reindex` verb.

**Search/index scope:** stash-wide `akm search --type wiki` and `akm wiki search`
index and return wiki pages only. Files under `raw/` plus the wiki root
infrastructure files `schema.md`, `index.md`, and `log.md` are intentionally
excluded from the search index and search results.

**Not provided:** no `page-create`, `page-append`, `xref`, `log-append`,
`reindex`, or `migrate` verb. Those are the agent's job using its native
file tools against paths surfaced by `show` and `pages`.

#### wiki lint

```sh
akm wiki lint research
```

Runs deterministic structural checks and exits 1 when findings exist, 0 when
the wiki is clean. Output is always JSON with a `findings` array.

Finding kinds:

| Kind | Description |
| --- | --- |
| `orphan` | A page not linked from `index.md` |
| `broken-xref` | An internal link that points to a non-existent page |
| `missing-description` | A page without a frontmatter `description` field |
| `uncited-raw` | A file in `raw/` not referenced by any page |
| `stale-index` | `index.md` is out of date and needs to be regenerated |
| `broken-source` | A `sources:` entry in a page's frontmatter points to a raw file that does not exist |

#### wiki stash

```sh
akm wiki stash research ./paper.md
akm wiki stash research ./paper.md --as my-paper
echo "..." | akm wiki stash research -
```

Copies a file (or stdin) into `wikis/<name>/raw/<slug>.md`. Never overwrites
an existing raw file.

When `--as <slug>` is passed and the slug already exists, the command errors
with a `UsageError` — it does not silently rename the slug. Without `--as`,
auto-increment applies: if `paper` exists, the next attempt uses `paper-1`,
then `paper-2`, and so on.

### completions

Generate or install a bash completion script for `akm`. The script is built
dynamically from the command tree, so it always reflects the current set of
subcommands and flags.

```sh
akm completions                # Print bash completion script to stdout
akm completions --install      # Install to the appropriate directory
```

| Flag | Description |
| --- | --- |
| `--install` | Write the script to the XDG-compliant completions directory |
| `--shell` | Shell type (currently only `bash` is supported) |

**Manual activation:** pipe the output into your shell or source it from
your profile:

```sh
source <(akm completions)
```

**Install locations** (checked in order):

1. `$XDG_DATA_HOME/bash-completion/completions/akm`
2. `~/.local/share/bash-completion/completions/akm`
3. `~/.bash_completion.d/akm`

---

## Planned for v1 — agent, proposal, lesson, and distill

The commands below are declared by the v1 architecture spec
([`technical/v1-architecture-spec.md`](technical/v1-architecture-spec.md)
§9.4, §11–§14) and are part of the locked v1.0 surface. They are not yet
implemented. The shape and flag set documented here is the locked target —
implementations across milestones 0.7 – 1.0 must match this contract.

### agent

**Status: Planned for v1.**
Dispatch a configured external agent profile.

```sh
akm agent <profile> [args...]
```

Profiles ship for `opencode`, `claude`, `codex`, `gemini`, and `aider` and
can be extended via `agent.profiles[<name>]` in config (see
[Configuration](configuration.md)). akm spawns the profile's `bin` via the
shared spawn wrapper described in v1 spec §12.2 — captured or interactive
stdio, hard timeout, structured failure reasons.

Returns `{ ok, exitCode, stdout?, stderr?, durationMs, reason? }`. On
failure, `reason` is one of `timeout | spawn_failed | non_zero_exit |
parse_error`.

### reflect

**Status: Planned for v1.**
Produce reflection proposals for an existing asset. Proposals land in the
durable proposal queue and never mutate live stash content.

```sh
akm reflect <ref>
akm reflect [ref] --task "tighten the description"
akm reflect --profile claude
```

| Flag | Description |
| --- | --- |
| `--task` | Optional task hint passed into the reflection prompt |
| `--profile` | Override the default agent profile from `agent.default` |
| `--timeout-ms` | Override `agent.timeoutMs` for this call |

Emits the `reflect_invoked` usage event. Returns the `id` of the new
proposal row. Validation/timeout/parse errors return non-zero with a
`ConfigError` or `UsageError` envelope.

### propose

**Status: Planned for v1.**
Generate a brand-new asset proposal from a description. Output is always a
proposal — never a direct write.

```sh
akm propose <type> <name> --task "..."
akm propose skill code-review --task "PR-style review skill"
akm propose lesson docker-cleanup --task "consolidate cleanup feedback"
```

| Flag | Description |
| --- | --- |
| `--task` | Required. Free-form description of what the asset should do |
| `--profile` | Override the default agent profile |
| `--timeout` | Override `agent.timeoutMs` for this call |

Emits `propose_invoked`. Returns the new proposal id. Same failure model as
`reflect`.

### proposal

**Status: Planned for v1.**
Review and operate the proposal queue. Five subcommands.

```sh
akm proposal list
akm proposal list --status pending|accepted|rejected
akm proposal show <id>
akm proposal diff <id>
akm proposal accept <id>
akm proposal reject <id> --reason "..."
```

| Subcommand | Description |
| --- | --- |
| `list` | List proposals, optionally filtered by status |
| `show <id>` | Render the proposal body and metadata |
| `diff <id>` | Show the proposed delta vs. the live ref (or vs. empty) |
| `accept <id>` | Validate and promote via `writeAssetToSource` |
| `reject <id>` | Archive with a reason; body is preserved |

`accept` runs full validation (frontmatter, type-renderer, ref grammar,
write-source policy) **before** promoting. Failures keep the proposal in
`pending` and emit a structured `warnings` array. Successful promotion
emits the `promoted` event; reject emits `rejected`.

### distill

**Status: Planned for v1.**
Bounded in-tree LLM call that summarises feedback events for a ref into a
`lesson` proposal. Gated behind `llm.features.feedback_distillation`.

```sh
akm distill <ref>
```

If `llm.features.feedback_distillation` is `false` (the default), the
command exits with `ConfigError` and a hint pointing at the feature flag.
On a successful call, the response is written to the proposal queue as a
`lesson` (see v1 spec §13). The live stash is never mutated. Emits
`distill_invoked`.

### feedback (planned `--reason` extension)

**Status: Planned for v1.**
Existing `akm feedback` keeps its current shape (positive/negative/`--note`)
and gains an optional `--reason <slug>` flag whose value is forwarded into
`distill_invoked` payloads. Backwards compatible: scripts without `--reason`
behave exactly as today.
