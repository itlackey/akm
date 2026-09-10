# Getting Started

Install akm, connect a capability source, and pull a curated shortlist for a
real task. This path takes about five to seven minutes end to end.

## Runtime Requirement

The npm package requires Node.js >= 22 to bootstrap its command on every
platform. If a working Bun >= 1.0 is also on `PATH`, the package launcher
prefers Bun for execution; old, unusable, or absent Bun installations fall back
to Node.js. The standalone binaries are runtime-free.

## 1. Install

**Option 1 — npm package (recommended; requires [Node.js](https://nodejs.org) >= 22):**

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

**Success check:**

```sh
akm --version
```

## 2. Run setup

Guided, interactive setup is the default:

```sh
akm setup
```

`akm setup` walks through bundle location, embedding/LLM settings, semantic
search asset preparation, registries, sources, and task definitions. It also
reviews your scheduled task definitions and asks whether to activate them in
the OS scheduler — that part of the flow, plus how to migrate or repair
scheduler bindings later, is covered in [Scheduling](scheduling.md).

For non-interactive use — scripting, CI, or when you just want a working
bundle fast — use `--yes`:

```sh
akm setup --yes
akm setup --dir ~/custom-bundle   # optional: a non-default bundle location
```

**Success check:** either form creates `~/akm` (or your `--dir` path) — your
working bundle, the primary directory where your personal assets live — with
subdirectories for each asset type: `scripts/`, `skills/`, `commands/`,
`agents/`, `knowledge/`, `instructions/`, `workflows/`, `memories/`, `env/`,
`secrets/`, `facts/`, `lessons/`, `tasks/`, and `sessions/`. See
[Filesystem Layout](../architecture/internals/storage-locations.md) for
platform-specific paths and environment variable overrides.

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
akm help agents >> AGENTS.md
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
