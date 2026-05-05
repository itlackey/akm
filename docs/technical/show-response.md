# ShowResponse Field Reference

`akm show` returns a rendered asset payload. `brief` and `normal` currently use
the same base payload shape; `full` adds filesystem/editability metadata;
`summary` returns metadata-only subsets.

## Common Fields

Base show output may include:

| Field | Description |
| --- | --- |
| `type` | asset type |
| `name` | canonical asset name |
| `origin` | source identifier when available |
| `action` | what the consumer should do next |
| `description` | optional summary |
| `content` / `template` / `prompt` | type-specific payload |
| `parameters` | extracted parameter names |
| `run`, `setup`, `cwd` | script execution hints |
| `workflowTitle`, `workflowParameters`, `steps` | workflow payload |
| `keys`, `comments` | vault-safe key listing |

`--detail full` additionally adds:

- `schemaVersion`
- `path`
- `editable`
- `editHint`

## Per-Type Payloads

### `script`

- runnable script: `run`, optional `setup`, optional `cwd`
- otherwise: `content`

### `skill`

- `content`

### `command`

- `template`
- optional `description`
- optional `modelHint`
- optional `agent`
- optional `parameters`

### `agent`

- `prompt`
- optional `description`
- optional `modelHint`
- optional `toolPolicy`

### `knowledge`

- `content`
- supports `full`, `toc`, `frontmatter`, `section`, and `lines` views

### `memory`

- `content`

### `workflow`

- optional `description`
- `workflowTitle`
- optional `parameters`
- optional `workflowParameters`
- `steps`

### `vault`

Vault show never returns values.

- `keys`
- `comments`
- optional `description` synthesized from comments

### `wiki`

Two shapes exist:

1. **wiki page** (`wiki:name/page`)
   - `content`
   - same view modes as `knowledge`
2. **wiki root** (`wiki:name`)
   - `pages`
   - `raws`
   - `recentLog`
   - optional `description`
   - optional `lastModified`

## Summary Detail

`--detail summary` keeps only compact metadata. For example:

- general assets: `type`, `name`, `description`, `tags`, `parameters`, `action`, `origin`
- workflows: also `workflowTitle`
- scripts: may keep `run`
- vaults: may keep `keys` and `comments`

## Resolution

`akm show` is local-only. The flow (`src/commands/show.ts`):

1. Wiki-root shortcut: `wiki:<name>` with no page path returns the wiki summary.
2. `lookup(ref)` against the local FTS5 index (`src/indexer/indexer.ts`).
3. Fallback to on-disk type-dir traversal when the index has no row (covers
   the "indexed yet?" gap before `akm index` runs).

Summary/detail metadata is derived from rendered content and indexed entry
metadata. `akm show` no longer consults `.stash.json` directly as a first-class
runtime metadata layer; the remaining `.stash.json` compatibility path is
deprecated in 0.7.x and scheduled for removal in v0.8.0.

There is no remote provider fallback. If the asset is not on disk under a
configured source, show returns `NotFoundError`.
