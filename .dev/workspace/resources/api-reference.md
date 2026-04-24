# AKM CLI Reference

## Commands

### `akm search <query>`
Search local stash and configured registries for matching assets.

Options:
- `--type <type>` — Filter by asset type (skill, command, agent, knowledge, memory)
- `--source <source>` — Search source: `local`, `registry`, or `all` (default)
- `--limit <n>` — Max results (default: 10)

### `akm show <ref>`
Display the full content of an asset.

Accepts local refs (`skill:my-skill`) or remote URIs (`viking://resources/doc`).

### `akm add <ref>`
Install an asset from a registry into the local stash.

### `akm registry add <url>`
Register a new search provider.

Options:
- `--name <name>` — Display name for the registry
- `--provider <type>` — Provider type (skills-sh, openviking)
- `--options <json>` — Provider-specific options (e.g., apiKey)
