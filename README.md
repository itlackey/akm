# agentikit

Agentikit is a CLI tool and library for managing a stash of extension assets for AI coding assistants. It lets you **search**, **open**, and **run** tools, skills, commands, and agents from a stash directory.

## Installation

### npm / bun

```sh
npm install -g agentikit
# or
bun add -g agentikit
```

### Standalone binary

Use the install scripts for a copy/paste install:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash
# pin a release tag)
curl -fsSL https://raw.githubusercontent.com/itlackey/agentikit/main/install.sh | bash -s -- v1.2.3

# PowerShell (Windows)
irm https://raw.githubusercontent.com/itlackey/agentikit/main/install.ps1 -OutFile install.ps1; ./install.ps1
```

The shell installer verifies the downloaded binary against release `checksums.txt` before installing it.

## Stash model

Set a stash path via `AGENTIKIT_STASH_DIR`, or run `agentikit init` to create one automatically.

```sh
export AGENTIKIT_STASH_DIR=/abs/path/to/your-stash
```

Expected stash layout:

```
$AGENTIKIT_STASH_DIR/
├── tools/      # recursive files (.sh, .ts, .js, .ps1, .cmd, .bat)
├── skills/     # skill directories containing SKILL.md
├── commands/   # markdown files
├── agents/     # markdown files
└── knowledge/  # markdown files
```

## CLI usage

```sh
agentikit init                 # Initialize stash directory and set AGENTIKIT_STASH_DIR
agentikit index [--full]       # Build search index (incremental by default)
agentikit search [query]       # Search the stash
agentikit open <type:name>     # Open a stash asset by ref
agentikit run <type:name>      # Run a tool by ref
```

### search

Search the stash for extension assets.

```sh
agentikit search "deploy" --type tool --limit 10
```

- `query`: case-insensitive substring over stable names (relative paths)
- `--type`: `tool | skill | command | agent | knowledge | any` (default: `any`)
- `--limit`: defaults to `20`

Returns typed hits with `openRef` and, for tools, execution-ready `runCmd`.

### open

Open a hit using `openRef` from search results.

```sh
agentikit open skill:code-review
agentikit open knowledge:guide.md --view toc
agentikit open knowledge:guide.md --view section --heading "Getting Started"
agentikit open knowledge:guide.md --view lines --start 10 --end 30
```

Returns full payload by type:

- `skill` — full `SKILL.md` content
- `command` — full markdown body as `template` (+ best-effort `description`)
- `agent` — full markdown body as `prompt` (+ best-effort `description`, `toolPolicy`, `modelHint`)
- `tool` — `runCmd`/`kind`
- `knowledge` — content with optional view modes (`full`, `toc`, `frontmatter`, `section`, `lines`)

### run

Execute a tool from the stash by its `openRef`. Only `tool:` refs are supported.

```sh
agentikit run tool:docker%2Fbuild-image.sh
```

Returns `{ type, name, path, output, exitCode }`.

Tool command generation:

- `.sh` → `bash "<absolute-file>"`
- `.ps1` → `powershell -ExecutionPolicy Bypass -File "<absolute-file>"`
- `.cmd`/`.bat` → `cmd /c "<absolute-file>"`
- `.ts`/`.js`:
  - find nearest `package.json` from script dir upward to stash `tools/` root
  - if found: `cd "<pkgDir>" && bun "<absolute-file>"`
  - else: `bun "<absolute-file>"`
  - optional: set `AGENTIKIT_BUN_INSTALL=true` to include `bun install` before running

## Library API

Agentikit also exports its core functions for use as a library:

```ts
import { agentikitSearch, agentikitOpen, agentikitRun, agentikitInit, agentikitIndex } from "agentikit"
```

- `agentikitSearch({ query, type?, limit? })` — search the stash
- `agentikitOpen({ ref, view? })` — open a stash asset
- `agentikitRun({ ref })` — run a tool
- `agentikitInit()` — initialize stash directory
- `agentikitIndex()` — build/rebuild search index

## Notes

- Agentikit does not install or copy kit files.
- Missing or unreadable stash paths return friendly errors.
