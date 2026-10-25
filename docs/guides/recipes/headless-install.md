# Recipe: Headless Install

A precise, no-prompts sequence for automated or agent-driven setup of `akm` —
no interactive wizard, no assumed defaults.

```sh
#!/usr/bin/env bash
set -euo pipefail

# 1. Install (standalone binary, runtime-free)
curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash

# 2. Initialize the bundle directory and accept all defaults (no prompts)
akm setup --yes

# 3. Don't rely on the implicit semantic-search default in an unattended
#    script — the default can vary by release and by install path. Set it
#    explicitly so this script's behavior is deterministic. `auto` uses local
#    embeddings (downloaded on first index run); `off` skips them entirely.
akm config set semanticSearchMode auto

# 4. Add sources (adjust paths as needed)
akm bundle add /path/to/skills

# 5. Build the search index (downloads the embedding model on first run if
#    semantic search is enabled)
akm index

# 6. Verify
akm info
akm search "test"

# 7. Install agent guidance
akm hints --detail brief >> AGENTS.md

echo "akm setup complete"
```

## Notes on each step

**Install.** The standalone binary (step 1) is runtime-free. The npm package
(`npm install -g akm-cli`, or one-shot via `npx akm-cli <command>`) requires
Node.js >= 24; a working Bun >= 1.0 is optional and preferred for execution
after Node starts the package launcher.

**Setup.** `akm setup --yes` takes the detected default for every question:
each agent program found on `PATH` is enabled, and a local model server it
finds becomes the connection. To point it at an endpoint instead, answer the
question with a flag; the key is named by the environment variable that holds
it and never appears on the command line:

```sh
akm setup --yes --endpoint https://api.example.com/v1 --api-key-env EXAMPLE_API_KEY
```

`--no-probe` keeps the run offline (the endpoint's model list is not fetched).
For the full set of flags, see `akm setup --help`; for the config they write,
see [configuration.md](../../reference/configuration.md).

**Semantic search.** Headless setups (`--yes` or `--from`, no wizard
prompts) defer the embedding-model download to the first `akm index` run,
unlike the interactive wizard which downloads immediately during `akm
setup`. Set the mode explicitly rather than relying on the implicit default:

```sh
akm config set semanticSearchMode auto   # local embeddings, downloaded on first index
akm config set semanticSearchMode off    # skip embeddings entirely
```

For resource requirements and remote-embedding alternatives, see
[configuration.md](../../reference/configuration.md).

**Add source.** `akm bundle add <path|github:owner/repo|@scope/package>`
registers a directory or package as a source. Add every source before
indexing.

**Index and verify.** `akm index` builds the search index; `akm info` reports
`indexStats.entryCount` and `semanticSearch.status`; `akm search "<query>"`
confirms retrieval actually returns results.

**Install agent guidance.** `akm hints --detail brief >> AGENTS.md` appends the
canonical usage block agents need to discover and use the library. Run this
after indexing so the guidance matches the installed version.

## See also

- [configuration.md](../../reference/configuration.md) — full configuration
  key reference
- [docs/agents/agent-install.md](../../agents/agent-install.md) — agent-facing
  entry point that links here
