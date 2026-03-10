# CLI Reference

The CLI is called `akm` (Agent Kit Manager). All commands return structured
JSON to stdout. Errors include `error` and `hint` fields.

## Commands

### init

Create the stash directory structure and config file.

```sh
akm init
```

Creates `tools/`, `skills/`, `commands/`, `agents/`, `knowledge/`, and
`scripts/` subdirectories under the stash path. See
[filesystem.md](filesystem.md) for config file locations.

### index

Build or refresh the search index.

```sh
akm index          # Incremental (only changed directories)
akm index --full   # Full rebuild
```

Returns stats: `totalEntries`, `generatedMetadata`, `directoriesScanned`,
`directoriesSkipped`, and `timing` breakdown in milliseconds.

### search

Search local stash assets, registry kits, or both.

```sh
akm search "deploy"
akm search "deploy" --type tool --limit 10
akm search "lint" --source registry
akm search "docker" --source both --usage none
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `tool`, `skill`, `command`, `agent`, `knowledge`, `script`, `any` | `any` | Filter by asset type |
| `--limit` | number | `20` | Maximum results |
| `--source` | `local`, `registry`, `both` | `local` | Where to search |
| `--usage` | `none`, `both`, `item`, `guide` | `both` | Usage metadata mode |

Local results include `openRef` for use with `akm show`, plus `score` and
`whyMatched` for explainability. Registry results include `installRef` and
`installCmd`.

### show

Display an asset by ref.

```sh
akm show tool:deploy.sh
akm show skill:code-review
akm show agent:architect.md
akm show command:release.md
akm show knowledge:guide.md --view toc
akm show knowledge:guide.md --view section --heading "Authentication"
akm show knowledge:guide.md --view lines --start 10 --end 30
akm show knowledge:guide.md --view frontmatter
```

Returns type-specific payloads:

| Type | Key fields |
| --- | --- |
| tool / script | `runCmd`, `kind` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description` |
| agent | `prompt`, `description`, `modelHint` |
| knowledge | `content` with view modes: `full`, `toc`, `frontmatter`, `section`, `lines` |

If the ref points to an installed package that is not yet present locally,
akm auto-installs it before showing the asset.

### add

Install a kit from npm, GitHub, any git host, or a local directory.

```sh
akm add @scope/kit
akm add npm:@scope/kit@latest
akm add github:owner/repo#v1.2.3
akm add https://github.com/owner/repo
akm add git+https://gitlab.com/org/kit
akm add ./path/to/local/kit
```

See [registry.md](registry.md) for the full install flow.

### submit

Create a registry submission PR for a public npm package or GitHub repo.

```sh
akm submit
akm submit owner/repo
akm submit @scope/kit --name "My Kit" --description "..." --tags skill,tool
akm submit --dry-run
```

If you run `akm submit` from a local kit directory, akm reads `package.json`,
infers a public npm or GitHub ref, generates a `manual-entries.json` entry,
forks `itlackey/agentikit-registry`, and opens a pull request with `gh`.

| Flag | Description |
| --- | --- |
| `--name` | Override the display name |
| `--description` | Override the one-line summary |
| `--tags` | Comma-separated tags |
| `--asset-types` | Comma-separated asset types (`tool`, `skill`, `command`, `agent`, `knowledge`, `script`) |
| `--author` | Override the author |
| `--license` | Override the license |
| `--homepage` | Override the homepage URL |
| `--dry-run` | Validate the entry and print the git/gh commands without creating a PR |
| `--cleanup-fork` | Show the fork cleanup command (run it after the PR is merged) |

`akm submit` requires GitHub CLI (`gh`) and an authenticated GitHub session.

### list

Show installed kits and their status.

```sh
akm list
```

Each entry includes `status.cacheDirExists` and `status.stashRootExists`.

### remove

Remove an installed kit by id or ref and reindex.

```sh
akm remove npm:@scope/kit
akm remove owner/repo
```

### update

Update one or all installed kits to the latest available version.

```sh
akm update npm:@scope/kit
akm update --all
akm update --all --force   # Force fresh download even if version is unchanged
```

| Flag | Description |
| --- | --- |
| `--all` | Update all installed entries |
| `--force` | Delete cached extraction before re-downloading (replaces the old `reinstall` command) |

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

### clone

Copy an asset from any source into the working stash (or a custom
destination) for editing.

```sh
akm clone tool:deploy.sh
akm clone "npm:@scope/pkg//tool:deploy.sh"
akm clone tool:deploy.sh --name my-deploy.sh
akm clone tool:deploy.sh --force
akm clone tool:deploy.sh --dest ./project/.claude
akm clone "npm:@scope/pkg//tool:deploy.sh" --dest /tmp/preview
```

| Flag | Description |
| --- | --- |
| `--name` | New name for the cloned asset |
| `--force` | Overwrite if the asset already exists at the destination |
| `--dest` | Destination directory (default: working stash). The type subdirectory (`tools/`, `skills/`, etc.) is appended automatically |

Skills (directories) are copied recursively. Other types copy a single file.

**Remote clone:** When the origin in the ref points to a package that is not
installed locally (e.g. an npm package or local path not in your stash
sources), akm fetches it to the cache automatically and extracts the
requested asset. The package is **not** registered as an installed kit --
use `akm add` for that.

```sh
# Clone a single tool from a remote package without installing the full kit
akm clone "npm:@scope/pkg//tool:deploy.sh"

# Clone from a local directory that isn't mounted as a stash source
akm clone "/path/to/kit//skill:code-review" --dest ./project/.claude
```

When `--dest` is provided, the working stash (`AKM_STASH_DIR`) is not
required. This makes clone usable in CI or fresh environments without
running `akm init` first.

### sources

List all resolved stash sources in priority order.

```sh
akm sources
```

### config

Read and write configuration.

```sh
akm config                          # Show current config
akm config list                     # List with effective providers
akm config get embedding.provider   # Read one key
akm config set llm.maxTokens 512    # Set one key
akm config unset llm.apiKey         # Remove a key
akm config providers embedding      # List available embedding providers
akm config use embedding ollama     # Switch embedding provider
```

See [configuration.md](configuration.md) for details.
