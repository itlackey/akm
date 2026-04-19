# CLI Reference

The CLI is called `akm` (Agent Kit Manager). Commands default to structured
JSON at `--detail brief`. Use `--format json|text|yaml` and `--detail
brief|normal|full` when you want a different presentation. Errors include
`error` and `hint` fields.

## Commands

### init

Create the stash directory structure and persist the working stash path in
config.

```sh
akm init                         # Initialize at the default location
akm init --dir ~/custom-stash    # Initialize at a custom location
```

Creates `scripts/`, `skills/`, `commands/`, `agents/`, `knowledge/`, and `memories/`
subdirectories under the stash path. See
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
`directoriesSkipped`, `verification`, and `timing` breakdown in milliseconds.
Use `--verbose` to print the indexing mode, semantic-search settings, and
phase-by-phase progress to stderr while the index is being built.

### search

Search stash assets, registry kits, or both.

```sh
akm search "deploy"
akm search "deploy" --type script --limit 10
akm search "lint" --source registry
akm search "docker" --source both --detail full
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `memory`, `script`, `any` | `any` | Filter by asset type |
| `--limit` | number | `20` | Maximum results |
| `--source` | `stash`, `registry`, `both` | `stash` | Where to search (`local` is an alias for `stash`) |
| `--format` | `json`, `text`, `yaml` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full` | `brief` | Output detail level |

Local hits include a `ref` handle for use with `akm show`. Key fields in
search results:

- **`ref`** -- The asset handle to pass to `akm show` (e.g. `script:deploy.sh`)
- **`name`** -- The asset's filename or identifier
- **`origin`** -- The source kit (e.g. `npm:@scope/pkg`), present only for managed source assets
- **`id`** -- Registry-level kit identifier (registry hits only)

The default brief shape is intentionally small: local hits expose `type`,
`name`, `description`, and `action`; registry hits expose `type`, `name`,
`id`, `description`, `action`, and `curated`. `--detail normal` adds commonly
useful fields like `ref`, `origin`, `size`, and `tags`. `--detail full`
includes debug-oriented fields such as scores, match explanations, timings,
and stash metadata.

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
| `--type` | `skill`, `command`, `agent`, `knowledge`, `memory`, `script`, `any` | `any` | Filter curated results by asset type |
| `--limit` | number | `4` | Maximum curated results |
| `--source` | `stash`, `registry`, `both` | `stash` | Where to search before curating |

`akm curate` selects high-signal results, prefers one strong match per asset
type by default, and includes direct follow-up commands such as `akm show <ref>`
or `akm add <kit>` so you can immediately inspect or install what it found.

### show

Display an asset by ref. Knowledge assets support view modes as positional
arguments after the ref.

```sh
akm show script:deploy.sh
akm show skill:code-review
akm show agent:architect
akm show command:release
akm show knowledge:guide toc
akm show knowledge:guide section "Authentication"
akm show knowledge:guide lines 10 30
akm show knowledge:guide frontmatter
```

The default JSON shape includes only action-relevant fields. For `show`,
`--detail normal` currently matches `brief`; `--detail full` adds verbose
metadata such as `schemaVersion`, `path`, `editable`, and `editHint`.

Returns type-specific payloads:

| Type | Key fields |
| --- | --- |
| script | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description` |
| agent | `prompt`, `description`, `modelHint` |
| knowledge | `content` with view modes: `full`, `toc`, `frontmatter`, `section`, `lines` |
| memory | `content` |

Assets from OpenViking sources use standard `type:name` refs like
everything else, and always return `editable: false`.

If the ref points to a package origin that is not installed, `akm show`
returns guidance to run `akm add <origin>` first.

### How `add` works

`akm add` infers what to do from the input:

| Input | What happens |
| --- | --- |
| `akm add ~/.claude/skills` | Registers a local directory as a source |
| `akm add github:owner/repo` | Fetches and caches a managed source |
| `akm add @scope/kit` | Fetches and caches a managed source from npm |
| `akm add https://docs.example.com` | Crawls and caches a website as knowledge |
| `akm registry add <url>` | Adds a discovery registry (separate concept) |

HTTP(S) URLs pointing to known git hosts (GitHub, GitLab, Bitbucket, Codeberg,
SourceHut) or ending in `.git` are treated as git sources. All other HTTP(S)
URLs are treated as website sources.

### add

Add a source — a local directory, npm package, GitHub repo, git URL, or website.

```sh
akm add ~/.claude/skills              # Local directory
akm add @scope/kit                    # npm package
akm add npm:@scope/kit@latest         # npm with version
akm add github:owner/repo#v1.2.3     # GitHub with tag
akm add https://github.com/owner/repo
akm add git+https://gitlab.com/org/kit
akm add ./path/to/local/kit
akm add context-hub
akm add https://docs.example.com --name docs              # Website
akm add https://docs.example.com --max-pages 100 --max-depth 5
```

| Flag | Description |
| --- | --- |
| `--name` | Human-friendly name for the source |
| `--provider` | Provider type (e.g. `openviking`). Required for remote provider sources |
| `--options` | Provider options as JSON (e.g. `'{"apiKey":"key"}'`) |
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

`akm add context-hub` is a convenience alias that adds the context-hub
GitHub repo as a git provider source.

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
akm remove npm:@scope/kit           # Managed source by id
akm remove owner/repo               # Managed source by ref
akm remove ~/.claude/skills         # Local source by path
akm remove my-provider              # Any source by name
```

### update

Update one or all managed sources to the latest available version. Local and
remote sources are not updatable — akm explains why if you target one.

```sh
akm update npm:@scope/kit
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
| `--skipChecksum` | Skip checksum verification during upgrade (not recommended) |

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
# Clone a single script from a remote package without installing the full kit
akm clone "npm:@scope/pkg//script:deploy.sh"

# Clone from a local directory that isn't configured as a search path
akm clone "/path/to/kit//skill:code-review" --dest ./project/.claude
```

When `--dest` is provided, the working stash (`AKM_STASH_DIR`) is not
required. This makes clone usable in CI or fresh environments without
running `akm init` first.

### registry

Manage kit registries. The `registry` command has four subcommands:

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

```sh
akm add http://localhost:1933 --provider openviking --options '{"apiKey":"key"}'
```

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
| `--manual` | Path to a JSON file with manual kit entries |
| `--npmRegistry` | npm registry base URL (default: `https://registry.npmjs.org`) |
| `--githubApi` | GitHub API base URL (default: `https://api.github.com`) |
| `--format` | Output format: `json` or `text` (default: `json`) |

#### registry search

Search all enabled registries for kits.

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

### hints

Print agent-facing instructions for using `akm`. Add this output to your
`AGENTS.md`, `CLAUDE.md`, or system prompt so your agent knows how to use
the CLI.

```sh
akm hints
```

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
