# Filesystem Layout

Quick reference for where akm stores stash data, config, and cache state.

## Working Stash

| Env / Default | Path |
| --- | --- |
| `AKM_STASH_DIR` | user-defined |
| Linux / macOS | `~/akm` |
| Windows | `%USERPROFILE%\Documents\akm` |

Canonical built-in type directories come from `TYPE_DIRS`:

```text
<stash>/
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

Some configured stash sources are mirrored into cache before indexing:

- git-backed stash sources
- website sources
- installed kits from registries

Once mirrored, they are indexed like local stash directories.
