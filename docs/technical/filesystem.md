# Filesystem Layout

Quick reference for where akm stores source data, config, and cache state.

## Working Stash

The working stash is the user's primary writable filesystem source, created by
`akm init`. It's just a filesystem source — the same path can be referenced by
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
  workflows/
  memories/
  vaults/
  wikis/
```

Directory names still act as strong classification hints, but scripts and
markdown assets can also be recognized outside these folders.

## Cache

akm keeps operational state under the cache directory:

| Purpose | Path |
| --- | --- |
| index DB | `$XDG_CACHE_HOME/akm/index.db` |
| workflow DB | `$XDG_CACHE_HOME/akm/workflow.db` |
| semantic status | `$XDG_CACHE_HOME/akm/semantic-status.json` |
| registry cache | `$XDG_CACHE_HOME/akm/registry/` |
| registry-index cache | `$XDG_CACHE_HOME/akm/registry-index/` |
| binaries | `$XDG_CACHE_HOME/akm/bin/` |

`bin/` is cache-managed, not stash-local.

## Config

| Platform | Path |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/akm/config.json` (default `~/.config/akm/config.json`) |
| Windows | `%APPDATA%\akm\config.json` |

Override with `AKM_CONFIG_DIR`.

## `.stash.json`

Place `.stash.json` inside a type directory to provide curated metadata for the
assets in that directory.

### Supported entry fields

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
- `workflow`
- `memory`
- `vault`
- `wiki`

### Example

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

## Cache-Backed Sources

Some configured sources are materialised into cache before indexing:

- `git` sources (cloned/pulled into `cacheDir`)
- `website` sources (recrawled and converted to markdown)
- `npm` sources (installed into `cacheDir`)

Once materialised, they are indexed like local filesystem sources. Cache
materialisation is driven by each provider's `sync()` method
(`src/sources/source-providers/`), invoked through `ensureSourceCaches()` in
`src/indexer/search-source.ts`.
