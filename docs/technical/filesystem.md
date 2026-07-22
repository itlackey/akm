# Filesystem Layout

Quick reference for where akm stores source data, config, and cache state.

## Working Stash

The working stash is the user's primary writable filesystem source, created by
`akm setup`. It's just a filesystem source — the same path can be referenced by
`config.stashDir` and as a `sources[]` entry of kind `filesystem`.

| Env / Default | Path |
| --- | --- |
| `AKM_STASH_DIR` | user-defined |
| Linux / macOS | `~/akm` |
| Windows | `%USERPROFILE%\Documents\akm` |

Canonical built-in type directories come from `TYPE_DIRS` in
`src/core/asset-spec.ts`:

```text
<source>/
  scripts/
  skills/
  commands/
  agents/
  knowledge/
  env/
  secrets/
  workflows/
  memories/
  wikis/
  lessons/
```

Directory names still act as strong classification hints, but scripts and
markdown assets can also be recognized outside these folders.

## Data and Cache

akm uses four XDG-compliant directories. Durable databases live in `$DATA`
(`~/.local/share/akm`); regenerable data lives in `$CACHE` (`~/.cache/akm`).

| Purpose | Path |
| --- | --- |
| index DB | `$XDG_DATA_HOME/akm/index.db` (`~/.local/share/akm/index.db`) |
| state DB (events, proposals, task history, workflow run state) | `$XDG_DATA_HOME/akm/state.db` (`~/.local/share/akm/state.db`) |
| lock file | `$XDG_DATA_HOME/akm/akm.lock` (`~/.local/share/akm/akm.lock`) |
| config backups | `$XDG_DATA_HOME/akm/config-backups/` |
| semantic status | `$XDG_CACHE_HOME/akm/semantic-status.json` |
| registry cache | `$XDG_CACHE_HOME/akm/registry/` |
| registry-index cache | `registry_index_cache` table in `$XDG_DATA_HOME/akm/index.db` |
| task run logs | `$XDG_CACHE_HOME/akm/tasks/logs/` |
| binaries | `$XDG_CACHE_HOME/akm/bin/` |

Override env vars: `AKM_DATA_DIR` (for `$DATA`), `AKM_CACHE_DIR` (for `$CACHE`),
`AKM_STATE_DIR` (for task log state at `~/.local/state/akm`).

`bin/` is cache-managed, not stash-local.

## Config

| Platform | Path |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/akm/config.json` (default `~/.config/akm/config.json`) |
| Windows | `%APPDATA%\akm\config.json` |

Override with `AKM_CONFIG_DIR`.

## Legacy `.stash.json`

`.stash.json` is a pre-0.9.0 per-directory metadata sidecar. The live indexer
no longer reads it; the only remaining reader is the storage migrator, which
folds each sidecar's overrides into the corresponding asset's inline
frontmatter (or, for scripts, header comments) and then deletes the sidecar.
Do not create new stashes with it — use frontmatter for markdown assets and
structured script header comments (`@param`, `@run`, `@setup`, `@cwd`) for
descriptions, parameters, and execution hints instead.

## Cache-Backed Sources

Some configured sources are materialised into cache before indexing:

- `git` sources (cloned/pulled into `cacheDir`)
- `website` sources (recrawled and converted to markdown)
- `npm` sources (installed into `cacheDir`)

Once materialised, they are indexed like local filesystem sources. Cache
materialisation is driven by each provider's `sync()` method
(`src/sources/providers/`), invoked through `ensureSourceCaches()` in
`src/indexer/search-source.ts`.
