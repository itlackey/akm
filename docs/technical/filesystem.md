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

## Data and Cache (v0.8.0+)

akm uses four XDG-compliant directories. Durable databases live in `$DATA`
(`~/.local/share/akm`); regenerable data lives in `$CACHE` (`~/.cache/akm`).

| Purpose | Path |
| --- | --- |
| index DB | `$XDG_DATA_HOME/akm/index.db` (`~/.local/share/akm/index.db`) |
| workflow DB | `$XDG_DATA_HOME/akm/workflow.db` (`~/.local/share/akm/workflow.db`) |
| state DB (events, proposals, task history) | `$XDG_DATA_HOME/akm/state.db` (`~/.local/share/akm/state.db`) |
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

> **Upgrading from v0.7?** Run `akm-migrate-storage --yes` to move
> `index.db` and `workflow.db` from `$CONFIG` to `$DATA`. See
> [docs/migration/v0.7-to-v0.8.md](../migration/v0.7-to-v0.8.md) for the full
> guide.

## Config

| Platform | Path |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/akm/config.json` (default `~/.config/akm/config.json`) |
| Windows | `%APPDATA%\akm\config.json` |

Override with `AKM_CONFIG_DIR`.

## Legacy `.stash.json`

`.stash.json` support was removed in v0.8.0. Do not create new stashes with it.
If you are upgrading from v0.7, migrate any existing `.stash.json` sidecars to
inline metadata before indexing. Prefer frontmatter for markdown assets and
structured script header comments for descriptions, parameters, and execution
hints.

### Supported legacy entry fields

| Field | Notes |
| --- | --- |
| `name`, `type` | required |
| `description`, `tags`, `aliases` | search and display metadata |
| `filename` | on-disk file mapping |
| `quality`, `source`, `confidence` | provenance/quality metadata |
| `usage`, `examples`, `searchHints`, `intent` | hint text for search |
| `toc` | markdown heading cache |
| `run`, `setup`, `cwd` | script execution hints |
| `parameters` | structured parameters |
| `wikiRole`, `pageKind`, `xrefs`, `sources` | wiki-specific metadata |
| `fileSize` | sizing/token estimation |

### Current type values

Built-in `type` values are:

- `script`
- `skill`
- `command`
- `agent`
- `knowledge`
- `env`
- `secret`
- `workflow`
- `memory`
- `wiki`
- `lesson`

### Legacy example

```json
{
  "entries": [
    {
      "name": "release",
      "type": "workflow",
      "filename": "release.md",
      "description": "Release workflow for tagged builds",
      "searchHints": ["publish a release", "cut a release branch"],
      "parameters": [{ "name": "version", "description": "Version to release" }]
    }
  ]
}
```

### Filename resolution

If `filename` is omitted, akm does not blindly choose the first file. It uses
asset-type-specific canonical path rules and matching heuristics to resolve the
entry to the right on-disk file.

### Migration guidance

When moving away from `.stash.json` before the v0.8.0 removal:

- move markdown `description`, `tags`, and `params` into frontmatter
- move script descriptions into the file's leading comment block
- move script parameter docs into `@param` comments
- move script exec hints into `@run`, `@setup`, and `@cwd` header tags
- keep `package.json` descriptions/keywords for package-level fallback metadata

## Cache-Backed Sources

Some configured sources are materialised into cache before indexing:

- `git` sources (cloned/pulled into `cacheDir`)
- `website` sources (recrawled and converted to markdown)
- `npm` sources (installed into `cacheDir`)

Once materialised, they are indexed like local filesystem sources. Cache
materialisation is driven by each provider's `sync()` method
(`src/sources/providers/`), invoked through `ensureSourceCaches()` in
`src/indexer/search-source.ts`.
