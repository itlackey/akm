# agentikit

Agentikit is a simplified OpenCode stash toolkit. It exposes three tools to OpenCode sessions so agents can **search**, **open**, and **run** extension assets directly from a stash directory — with no concept of copying files into OpenCode directories.

## Installation

### npm / bun

```sh
npm install @itlackey/agentikit
# or
bun add @itlackey/agentikit
```

### Standalone binary

Use the install scripts for a copy/paste install:

```sh
# macOS / Linux (recommended: pin a release tag)
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash -s -- v1.2.3
```

```sh
# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1 v1.2.3
```

The shell installer verifies the downloaded binary against release `checksums.txt` before installing it.

### OpenCode plugin

Add agentikit as a plugin in your OpenCode config:

```json
{
  "plugins": {
    "agentikit": "@itlackey/agentikit"
  }
}
```

## Stash model

Set a stash path via `AGENTIKIT_STASH_DIR`.

```sh
export AGENTIKIT_STASH_DIR=/abs/path/to/your-stash
```

Expected stash layout:

```
$AGENTIKIT_STASH_DIR/
├── tools/      # recursive files, only .sh/.ts/.js are eligible
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
└── agents/     # markdown files
```

## OpenCode tools

When loaded as an OpenCode plugin, Agentikit provides three tools:

- `agentikit_search({ query, type?, limit? })`
- `agentikit_open({ ref })`
- `agentikit_run({ ref })`

### `agentikit_search`

Search the stash for extension assets.

- `query`: case-insensitive substring over stable names (relative paths)
- `type`: `tool | skill | command | agent | any` (default: `any`)
- `limit`: defaults to `20`

Returns typed hits with `openRef` and, for tools, execution-ready `runCmd`.

Tool command generation:

- `.sh` → `bash "<absolute-file>"`
- `.ts`/`.js`:
  - find nearest `package.json` from script dir upward to stash `tools/` root
  - if found: `cd "<pkgDir>" && bun "<absolute-file>"`
  - else: `bun "<absolute-file>"`
  - optional: set `AGENTIKIT_BUN_INSTALL=true` to include `bun install` before running

### `agentikit_open`

Open a hit using `openRef` from search results.

Returns full payload by type:

- `skill` → full `SKILL.md` content
- `command` → full markdown body as `template` (+ best-effort `description`)
- `agent` → full markdown body as `prompt` (+ best-effort `description`, `toolPolicy`, `modelHint`)
- `tool` → `runCmd`/`kind`

### `agentikit_run`

Execute a tool from the stash by its `openRef`. Only `tool:` refs are supported.

- `ref`: open reference of a tool returned by `agentikit_search`

Returns `{ type, name, path, output, exitCode }`.

## Usage example

1. `agentikit_search({ query: "deploy", type: "tool" })`
2. `agentikit_run({ ref: "<openRef from search>" })`

Or:

1. `agentikit_search({ query: "release", type: "command" })`
2. `agentikit_open({ ref: "<openRef from search>" })`
3. Apply returned template in-session

## Package exports

- `plugin` — OpenCode plugin exposing `agentikit_search`, `agentikit_open`, and `agentikit_run`
- `agentikitSearch` / `agentikitOpen` / `agentikitRun` — direct library APIs

## Notes

- Agentikit does not write to `.opencode/`.
- Agentikit does not install or copy kit files.
- Missing or unreadable stash paths return friendly errors.

## Docs

- [Plugins](https://opencode.ai/docs/plugins/)
- [Commands](https://opencode.ai/docs/commands/)
- [Agents](https://opencode.ai/docs/agents/)
- [Agent Skills](https://opencode.ai/docs/skills/)
- [Custom tools](https://opencode.ai/docs/custom-tools/)
- [Config](https://opencode.ai/docs/config/)
