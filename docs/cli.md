# CLI Reference

The CLI is called `akm` (Agent Kit Manager). Commands default to structured
JSON at `--detail brief`. Use `--format json|text|yaml` and `--detail
brief|normal|full` when you want a different presentation. Errors include
`error` and `hint` fields.

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
akm search "deploy" --type script --limit 10
akm search "lint" --source registry
akm search "docker" --source both --detail full
```

| Flag | Values | Default | Description |
| --- | --- | --- | --- |
| `--type` | `skill`, `command`, `agent`, `knowledge`, `script`, `any` (`tool` accepted as alias for `script`) | `any` | Filter by asset type |
| `--limit` | number | `20` | Maximum results |
| `--source` | `local`, `registry`, `both` | `local` | Where to search |
| `--format` | `json`, `text`, `yaml` | `json` | Output format |
| `--detail` | `brief`, `normal`, `full` | `brief` | Output detail level |

Local hits include a `ref` handle for use with `akm show`. The default brief
shape is intentionally small: local hits expose `type`, `name`, `ref`,
`description`, `size`, and `action`; registry hits expose `type`, `name`, `id`,
`description`, `action`, and `curated`. `--detail normal` adds commonly useful
fields like `origin` and `tags`. `--detail full` includes debug-oriented fields
such as scores, match explanations, timings, and stash metadata.

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
| script (alias: tool) | `run`, `setup`, `cwd` |
| skill | `content` (full SKILL.md) |
| command | `template`, `description` |
| agent | `prompt`, `description`, `modelHint` |
| knowledge | `content` with view modes: `full`, `toc`, `frontmatter`, `section`, `lines` |

If the ref points to a package origin that is not installed, `akm show`
returns guidance to run `akm add <origin>` first.

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
| `--dest` | Destination directory (default: working stash). The type subdirectory (`tools/`, `skills/`, etc.) is appended automatically |

Skills (directories) are copied recursively. Other types copy a single file.

**Remote clone:** When the origin in the ref points to a package that is not
installed locally (e.g. an npm package or local path not in your stash
sources), akm fetches it to the cache automatically and extracts the
requested asset. The package is **not** registered as an installed kit --
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

### sources

List all resolved stash sources in priority order.

```sh
akm sources
```

### config

Read and write configuration.

```sh
akm config                          # Show current config
akm config list                     # List current config
akm config get output.format        # Read one key
akm config set output.detail full   # Set one key
akm config unset llm                # Remove an optional key
```

See [configuration.md](configuration.md) for details.
