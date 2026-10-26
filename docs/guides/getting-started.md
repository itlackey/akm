# Getting Started

Install akm, connect a capability source, and pull a curated shortlist for a
real task. This path takes about five to seven minutes end to end.

## Runtime Requirement

The npm package requires Node.js >= 24 to bootstrap its command on every
platform. If a working Bun >= 1.0 is also on `PATH`, the package launcher
prefers Bun for execution; old, unusable, or absent Bun installations fall back
to Node.js. The standalone binaries are runtime-free.

## 1. Install

**Option 1 — npm package (recommended; requires [Node.js](https://nodejs.org) >= 24):**

```sh
npm install -g akm-cli
```

**Option 2 — Prebuilt binary (no runtime required):**

```sh
# Linux / macOS
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# Windows (PowerShell)
irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex
```

Or download a standalone binary directly from the
[GitHub releases](https://github.com/itlackey/akm/releases) page.

Hitting a PowerShell execution-policy error on Windows? See
[Troubleshooting](#troubleshooting) at the end of this guide.

### Standalone binary and semantic search

Local semantic search (`semanticSearchMode: auto`) runs its embedding model on
ONNX Runtime. A standalone binary carries the library for its platform. The
first time it embeds, it copies that library once into akm's cache directory,
under `onnxruntime/<version>-<platform>-<arch>/` (18 to 34 MB depending on the
platform; `akm info` prints the cache directory), and loads it from there. Two
limits follow:

- A standalone binary writes its native addon to the system temp directory and
  loads it from there, so a temp directory mounted `noexec` stops it. Set
  `TMPDIR` to a writable, executable directory. The cache directory must be on
  an executable mount too.
- Alpine/musl and Intel macOS have no native ONNX Runtime library. Semantic
  search is unavailable there: `akm index` reports it `blocked` with the reason
  and search stays keyword-only. A remote `embedding.endpoint` still works.

### akm's own agent runtime

With a connection and no harness, `akm agent` and the other agent work run on
akm's own runtime, a pinned OpenCode 2 binary that akm runs as a process. This
is the same for the npm package and the standalone binary: nothing of OpenCode
is installed with akm, and the first time the runtime runs, akm downloads the
OpenCode binary for your platform from the npm registry (one package, about
114 MB, 240 MB on disk), checks it against the registry's integrity hash and
keeps it in the cache directory under `opencode/<version>/`. It is fetched once.
Three limits follow:

- That step needs the npm registry. Without network access for it, enable the
  `opencode` harness with an OpenCode 2 you have installed instead; no setting
  points akm's runtime at a binary of your own.
- Alpine/musl runs the musl build of that binary, which needs `libstdc++` and
  `libgcc`. The Alpine Node image already has them; on a bare Alpine install them
  with `apk add libstdc++ libgcc`.
- The binary runs from the cache directory and unpacks its own native pieces
  into `opencode-runtime/tmp/` in the data directory, so neither may be mounted
  `noexec`.

**Success check:**

```sh
akm --version
```

## 2. Run setup

Guided, interactive setup is the default:

```sh
akm setup
```

`akm setup` walks through the bundle location, the agent programs akm may use
(Claude Code, Codex, OpenCode, ...), a model connection (an OpenAI-compatible
endpoint, and which of its models answers each of `fast`, `balanced` and
`reasoning`), embeddings, semantic search asset preparation, registries,
sources, and task definitions. The model steps are optional: with no connection
and no agent program, everything that needs no model still works. Setup also
reviews your scheduled task definitions and asks whether to activate them in
the OS scheduler — that part of the flow, plus how to migrate or repair
scheduler bindings later, is covered in [Scheduling](scheduling.md).

For non-interactive use — scripting, CI, or when you just want a working
bundle fast — use `--yes`. A flag answers one question, so
`--endpoint` adds a model connection without prompting (see the
[CLI reference](../reference/cli.md#setup) for the rest):

```sh
akm setup --yes
akm setup --endpoint http://localhost:11434/v1 --yes   # also add a model endpoint
akm setup --dir ~/custom-bundle   # optional: a non-default bundle location
```

**Success check:** either form creates `~/akm` (or your `--dir` path) — your
working bundle, the primary directory where your personal assets live — with
subdirectories for each asset type: `scripts/`, `skills/`, `commands/`,
`agents/`, `knowledge/`, `instructions/`, `workflows/`, `memories/`, `env/`,
`secrets/`, `facts/`, `lessons/`, `tasks/`, and `sessions/`. See
[Filesystem Layout](../architecture/internals/storage-locations.md) for
platform-specific paths and environment variable overrides.

## Isolated sandbox workflow

Need a throwaway install for agent tests, CI repros, or docs verification? Run
akm inside a temporary HOME/XDG sandbox so nothing touches your normal local
state:

```sh
export AKM_SANDBOX="$(mktemp -d /tmp/akm-sandbox.XXXXXX)"
export HOME="$AKM_SANDBOX/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_STATE_HOME="$HOME/.local/state"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
akm setup --yes --dir "$AKM_SANDBOX/bundle"
```

Delete `$AKM_SANDBOX` when you're done to remove the whole throwaway install.

## 3. Connect a capability source

Add something to search. Point akm at a directory you already have, or
install the official onboarding bundle:

```sh
akm bundle add ~/.claude/skills              # an existing capability directory
akm bundle add github:itlackey/akm-stash     # the official onboarding bundle
```

Every source materialises files to a directory; akm indexes them locally.

**Success check:**

```sh
akm bundle list
```

lists the source you just added.

## 4. Index

```sh
akm index
```

`akm index` scans every configured source, then builds the search database.
Run it again whenever you add or change assets. Use `akm index --full` to
force a complete rebuild instead of an incremental update.

**Success check:** the command reports how many assets it indexed. If a
workflow file is malformed, akm skips that one asset, continues indexing the
rest of the bundle, and reports the skipped file in `warnings`.

## 5. Curate for a real task

Describe what you're trying to do, in plain language, instead of guessing an
exact asset name:

```sh
akm curate "deploy a Bun app"
```

Unlike `akm search`, `akm curate` attaches a preview and run details per hit,
adds related support refs, and summarizes the set — it's the usual starting
point for an agent.

**Success check:** the response includes a small shortlist; each entry
carries a `ref` field and a direct follow-up command such as `akm show <ref>`
or `akm bundle add <ref>`.

## 6. Show one of the results

Pick a `ref` from your curate output and load its full payload:

```sh
akm show <ref>            # e.g. akm show workflows/deploy
```

**Success check:** structured JSON with everything an agent needs to use the
asset — a `run` command plus optional `cwd` and `setup` for scripts, a
`prompt` payload for agents, or the document `content` for knowledge (append
`#<heading-slug>` to a ref for one section).

AKM retrieves every supported capability type. It directly orchestrates
defined execution surfaces such as workflows, agent dispatch, tasks, and
guarded subprocess injection. It does not blindly execute arbitrary indexed
content merely because that content appears in search results — `show` hands
your agent the payload; running it is a deliberate next step.

## 7. Tell your agent about akm

```sh
akm hints --detail brief >> AGENTS.md
```

**Success check:** `AGENTS.md` now has a block of agent-facing usage
instructions for the `akm` CLI, so any agent reading that file knows how to
call it.

## Optional: hand-write a script

Curious how classification works on a file you wrote yourself, rather than
one that came from a bundle? Add a small script and index it:

```sh
cat > ~/akm/scripts/hello.sh << 'EOF'
#!/usr/bin/env bash
# A simple greeting script
echo "Hello from akm!"
EOF
chmod +x ~/akm/scripts/hello.sh
akm index
akm show scripts/hello.sh
```

Any file with a known extension (`.sh`, `.ts`, `.py`, etc.) placed in your
working bundle is automatically recognized — the `scripts/` directory isn't
required, it just increases classification confidence. Assets use inline
metadata, not `.stash.json` sidecars: markdown assets use frontmatter, and
scripts use structured header comments (a short leading description,
`@param`, and execution hints like `@run` / `@setup` / `@cwd` when needed).
See [Concepts](concepts.md) for how classification works.

## What just happened?

You ran the retrieval loop end to end: **connect** (added a source),
**index** (built the search database), **curate** (got a relevance-ranked
shortlist for a real task), and **show** (loaded one asset's full payload).
The remaining links in that loop — **use/run** the asset, send **feedback**
on whether it helped, and let akm turn accumulated signal into a
**proposal** — are what the guides below cover.

## Next steps

- [Discover & Load](discover-and-load.md) — search, curate, and show in depth
- [Bundles](bundles.md) — sources, registries, and installing more capability
- [Capture Knowledge](capture-knowledge.md) — memories, imports, and wikis
- [Improve the Library](improve-the-library.md) — feedback, proposals, and
  the improvement loop
- [Run Workflows](run-workflows.md) — structured, resumable
  multi-step procedures

Scheduling `akm improve` and other background tasks — see
[Scheduling](scheduling.md).

## Troubleshooting

**Windows PowerShell execution policy.** `install.ps1` requires Windows
PowerShell 5.1 or newer (default on Windows 10 and Windows 11). If
`irm ... | iex` triggers a SmartScreen prompt or an ExecutionPolicy error, do
one of:

```powershell
# Allow scripts in this session only, then re-run the install:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex
```

```powershell
# Or download the script, unblock the file, and run it:
Invoke-WebRequest -Uri https://github.com/itlackey/akm/releases/latest/download/install.ps1 -OutFile install.ps1
Unblock-File .\install.ps1
.\install.ps1
```

Windows ARM64 hosts install the x64 binary, which Windows runs via x86_64
emulation. Native ARM64 support is tracked alongside Bun's ARM64-on-Windows
progress.
