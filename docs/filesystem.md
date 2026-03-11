# Filesystem Layout

Quick reference for where agentikit stores files.

## Stash Directory

The main working directory for all assets.

| Env / Default | Path |
|---|---|
| `AKM_STASH_DIR` | User-defined |
| Linux / macOS | `~/agentikit` |
| Windows | `%USERPROFILE%\Documents\agentikit` |

### Preferred Directories

The following directory names are **opt-in conventions** that increase
classification confidence during indexing. They are not required -- assets
are classified by file extension and content regardless of directory.

```
<stash>/
  scripts/        # Executable scripts (.sh, .ts, .js, .py, .rb, .go, etc.)
  skills/         # Skill definitions (SKILL.md)
  commands/       # Slash commands (.md with template/parameters)
  agents/         # Agent definitions (.md with model/tools)
  knowledge/      # Reference documents (.md)
  tools/          # Same as scripts/ (alias kept for convenience)
  bin/            # Auto-installed binaries (e.g. ripgrep)
```

A `.py` file placed in `scripts/` is classified at higher confidence than
one placed in `random/`, but both are recognized as scripts. See
[Concepts](concepts.md) for details on how classification works.

Each type directory may contain a `.stash.json` with per-asset metadata (see below).

## Asset Metadata (`.stash.json`)

Place a `.stash.json` file in any asset type subdirectory to provide curated
metadata for the assets it contains. When present, it takes priority over
auto-generated metadata from filenames, comments, and `package.json`.

### Schema

```json
{
  "entries": [
    {
      "name": "deploy",
      "type": "tool",
      "description": "Deploy the application to production",
      "tags": ["deploy", "infrastructure"],
      "entry": "deploy.sh",
      "quality": "curated",
      "source": "manual",
      "confidence": 1.0,
      "aliases": ["ship it", "push to prod"],
      "usage": [
        "Confirm staging health before running",
        "Pass a release tag as the first argument"
      ],
      "intent": {
        "when": "User wants to deploy",
        "input": "Optional release tag",
        "output": "Deployment status"
      },
      "examples": [
        "deploy the app",
        "ship latest to production"
      ],
      "intents": [
        "deploy application",
        "push to production"
      ]
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Asset identifier (usually the filename without extension) |
| `type` | string | yes | One of `tool`, `skill`, `command`, `agent`, `knowledge`, `script` |
| `description` | string | no | Human-readable summary of what the asset does |
| `tags` | string[] | no | Keywords for search and categorization |
| `entry` | string | no | Filename of the asset relative to this directory |
| `quality` | string | no | `"curated"` (hand-written) or `"generated"` (auto-created) |
| `source` | string | no | Origin of metadata: `"manual"`, `"package"`, `"frontmatter"`, `"comments"`, `"filename"`, `"llm"` |
| `confidence` | number | no | `0.0`-`1.0` confidence score (curated entries should use `1.0`) |
| `aliases` | string[] | no | Alternative names or phrases that match this asset |
| `usage` | string[] | no | Per-asset usage instructions shown alongside search results |
| `intent` | object | no | Structured intent with `when`, `input`, `output` fields |
| `examples` | string[] | no | Example queries or phrases a user might type |
| `intents` | string[] | no | Search phrases used for intent-based matching |
| `toc` | object[] | no | Table of contents (knowledge type only, usually auto-generated) |
| `run` | string | no | Explicit run command (e.g. `"bash deploy.sh"`), overrides auto-detection |
| `setup` | string | no | Setup command to run before execution (e.g. `"bun install"`) |
| `cwd` | string | no | Working directory for execution |

### How It Works

1. During indexing (`akm index`), each type directory is scanned for assets.
2. If a `.stash.json` exists in the directory, its entries are used as-is.
3. If no `.stash.json` is found, metadata is generated heuristically from
   filenames, code comments, frontmatter, and `package.json`, then written
   to a new `.stash.json` automatically.
4. To override generated metadata, edit the `.stash.json` directly. Set
   `quality` to `"curated"` and `source` to `"manual"` so the indexer
   preserves your changes on future runs.

### Tips

- You only need to include the fields you care about. `name` and `type` are
  the only required fields.
- Good `description` and `tags` values significantly improve search quality.
- The `usage` field is surfaced in search results to guide consumers on how
  to use the asset correctly.
- The `entry` field tells the indexer which file in the directory this entry
  maps to. Without it, the indexer defaults to the first file found.

## Config

Stored outside the stash directory, following XDG conventions.

| Platform | Path |
|---|---|
| Linux / macOS | `$XDG_CONFIG_HOME/agentikit/config.json` (default `~/.config/agentikit/config.json`) |
| Windows | `%APPDATA%\agentikit\config.json` |

## Cache

Used for SQLite indexes and registry downloads.

| Purpose | Path |
|---|---|
| Index DB | `$XDG_CACHE_HOME/agentikit/` (default `~/.cache/agentikit/`) |
| Registry cache | `~/.cache/agentikit/registry/` |
