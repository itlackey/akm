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
Register a new registry search provider.

Options:
- `--name <name>` — Display name for the registry
- `--provider <type>` — Provider type (e.g., skills-sh)
- `--options <json>` — Provider-specific options

### `akm stash add <url|path>`
Add a stash source (filesystem path or remote provider like OpenViking).

Options:
- `--provider <type>` — Provider type (e.g., openviking); required for URL sources
- `--name <name>` — Display name for the source
- `--options <json>` — Provider-specific options (e.g., apiKey)
