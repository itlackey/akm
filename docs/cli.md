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

Install a kit from npm, GitHub, or a local git directory.

```sh
akm add @scope/kit
akm add npm:@scope/kit@latest
akm add github:owner/repo#v1.2.3
akm add https://github.com/owner/repo
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
```

Reports per-entry change flags: `changed.version`, `changed.revision`,
`changed.any`.

### reinstall

Reinstall one or all kits from stored refs.

```sh
akm reinstall npm:@scope/kit
akm reinstall --all
```

### clone

Copy an asset from any source into the working stash for editing.

```sh
akm clone tool:deploy.sh
akm clone "npm:@scope/pkg//tool:deploy.sh"
akm clone tool:deploy.sh --name my-deploy.sh
akm clone tool:deploy.sh --force
```

Skills (directories) are copied recursively. Other types copy a single file.

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
