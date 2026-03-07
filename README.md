# agentikit

Agentikit is a stash toolkit for AI coding assistants. It exposes three tools so agents can **search**, **open**, and **run** extension assets directly from a stash directory. Works as both an **OpenCode plugin** and a **Claude Code plugin**.

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

Add agentikit to the `plugin` array in your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["@itlackey/agentikit"]
}
```

### Claude Code plugin

Install agentikit as a Claude Code plugin by pointing to the repo directory:

```sh
claude --plugin-dir /path/to/agentikit
```

Or add it to a plugin marketplace for team distribution. See the [Claude Code plugins documentation](https://code.claude.com/docs/en/plugins) for details.

Once installed, the plugin provides:

- **Skill** (`agentikit:stash`) — Claude automatically uses this when you ask about stash assets
- **Commands** — `/agentikit:search`, `/agentikit:open`, `/agentikit:run` slash commands

## Stash model

Set a stash path via `AGENTIKIT_STASH_DIR`.

```sh
export AGENTIKIT_STASH_DIR=/abs/path/to/your-stash
```

Expected stash layout:

```
$AGENTIKIT_STASH_DIR/
├── tools/      # recursive files (.sh, .ts, .js, .ps1, .cmd, .bat)
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
└── agents/     # markdown files
```

## Tools

When loaded as a plugin (OpenCode or Claude Code), Agentikit provides three tools:

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
- `.ps1` → `powershell -ExecutionPolicy Bypass -File "<absolute-file>"`
- `.cmd`/`.bat` → `cmd /c "<absolute-file>"`
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

- Agentikit does not write to `.opencode/` or `.claude/`.
- Agentikit does not install or copy kit files.
- Missing or unreadable stash paths return friendly errors.

## Docs

- **OpenCode**: [Plugins](https://opencode.ai/docs/plugins/) · [Commands](https://opencode.ai/docs/commands/) · [Agents](https://opencode.ai/docs/agents/) · [Agent Skills](https://opencode.ai/docs/skills/) · [Custom tools](https://opencode.ai/docs/custom-tools/) · [Config](https://opencode.ai/docs/config/)
- **Claude Code**: [Plugins](https://code.claude.com/docs/en/plugins) · [Skills](https://code.claude.com/docs/en/skills) · [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
