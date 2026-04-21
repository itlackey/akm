# Agent Install Guide

Step-by-step instructions for automated installation and configuration of
`akm`. Designed for agents performing headless setup on behalf of a user.

## 1. Install the Binary

Choose one method based on what runtime is available on the host:

```sh
# Option A: Standalone binary (no runtime dependencies)
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash

# Option B: Bun (if already installed)
bun install -g akm-cli

# Option C: npx (one-shot, no install needed)
npx akm-cli <command>
```

Verify the install:

```sh
akm --version
```

## 2. Detect the Host Environment

Collect information to guide configuration decisions:

```sh
# Check available disk space (for model downloads)
df -h ~

# Check available memory
free -m || vm_stat   # Linux or macOS

# Confirm akm info output after init
akm info
```

## 3. Initialize the Working Stash

```sh
# Use the default location (~/akm)
akm init

# Or specify a custom path
akm init --dir /path/to/stash
```

Verify:

```sh
akm config get stashDir
```

## 4. Configure Semantic Search (Local Embeddings)

The default configuration uses local embeddings with no external dependencies.
This is the recommended mode for automated installs.

**No action needed** — local embeddings are on by default. The model
(`Xenova/bge-small-en-v1.5`) is downloaded automatically on the first index
run and cached at `~/.cache/akm/models/`.

To confirm the embedding mode:

```sh
akm config get embedding   # Should return null (local mode)
```

To explicitly disable semantic search (e.g. on memory-constrained hosts):

```sh
akm config set semanticSearchMode off
```

To re-enable (default):

```sh
akm config unset semanticSearchMode
```

### Disk and Memory Requirements for Local Embeddings

| Resource | Requirement |
| --- | --- |
| Model download | ~30 MB (one-time, cached) |
| RAM during indexing | ~200 MB peak |
| Indexing time | Seconds to minutes depending on stash size |

If the host is too constrained for local embeddings, configure a remote
embedding endpoint instead (see [configuration.md](configuration.md)).

## 5. Add Sources

Add the directories or packages that contain the agent's assets:

```sh
# Add a local directory
akm add /path/to/skills

# Add a GitHub kit
akm add github:owner/repo

# Add an npm kit
akm add @scope/my-kit

# Add the current project's .claude directory (common for Claude Code)
akm add ./.claude
```

## 6. Build the Search Index

```sh
akm index
```

For a full rebuild (after changing embedding config or adding many sources):

```sh
akm index --full
```

Check status:

```sh
akm info
```

Look for:
- `indexStats.entryCount` > 0
- `semanticSearch.status` = `"ready-js"` or `"ready-vec"` (not `"blocked"`)

## 7. Verify Search Works

```sh
akm search "test"
```

If the stash is empty, add some content first (step 5), then re-index (step 6).

## 8. Expose akm to the Agent

Add the following to the agent's `AGENTS.md`, `CLAUDE.md`, or system prompt:

```sh
akm hints
```

Or add it manually:

```markdown
## Resources & Capabilities

You have access to a searchable library of scripts, skills, commands, agents,
knowledge, and memories via the `akm` CLI.

Use `akm search "<query>"` to find assets and `akm show <ref>` to inspect them.
Run `akm -h` for the full command reference.
```

## Quick Automation Script

The following sequence performs a complete headless setup with local
embeddings:

```sh
#!/usr/bin/env bash
set -euo pipefail

# 1. Install (standalone binary)
curl -fsSL https://raw.githubusercontent.com/itlackey/akm/main/install.sh | bash

# 2. Initialize stash
akm init

# 3. Local embeddings are on by default — nothing to configure

# 4. Add sources (adjust paths as needed)
# akm add ~/.claude/skills

# 5. Build index (downloads embedding model on first run)
akm index

# 6. Verify
akm info
echo "akm setup complete"
```

## Troubleshooting

### Semantic search is blocked

```sh
akm info   # Check semanticSearch.status and reason
```

Common reasons and fixes:

| Reason | Fix |
| --- | --- |
| `missing-package` | Run `bun add @huggingface/transformers` or `npm install @huggingface/transformers` |
| `native-lib-missing` | System libc incompatibility (Alpine/musl). Disable semantic search: `akm config set semanticSearchMode off` |
| `local-model-download` | Network issue during model download. Retry `akm index --full` once network is available |
| `remote-unreachable` | Remote embedding endpoint is down. Switch to local: `akm config unset embedding` |

### No results from search

1. Check that sources are configured: `akm list`
2. Check that the index is built: `akm info` → `indexStats.entryCount`
3. Re-run `akm index` if sources were added after the last index run

### Index database path

```sh
akm config path --all   # Shows config, stash, cache, and index paths
```
