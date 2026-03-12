# Registry

A registry is a searchable source of kits that `akm` can discover and
install from. The default registry type is a static JSON index, but akm
supports pluggable **registry providers** that can connect to different
ecosystems (e.g. skills.sh).

## Official Registry

akm ships with the official registry pre-configured:

```text
https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json
```

This registry is curated -- entries are reviewed before inclusion. To submit
a kit, open a pull request against the
[akm-registry](https://github.com/itlackey/akm-registry) repository.

## Managing Registries

Use the `akm registry` subcommand group to manage configured registries:

```bash
# List configured registries
akm registry list

# Add a third-party registry (static index)
akm registry add https://example.com/registry/index.json --name my-team

# Add a skills.sh registry
akm registry add https://skills.sh --name skills.sh --provider skills-sh

# Remove a registry by URL or name
akm registry remove my-team
```

Registries are stored in the `registries` array in your config file:

```jsonc
{
  "registries": [
    // Static index (default provider)
    { "url": "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json", "name": "official" },
    { "url": "https://example.com/registry/index.json", "name": "my-team", "enabled": true },
    // skills.sh provider
    { "url": "https://skills.sh", "name": "skills.sh", "provider": "skills-sh" }
  ]
}
```

Each entry supports:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string | (required) | URL of the registry index or API base |
| `name` | string | -- | Human-friendly label |
| `enabled` | boolean | `true` | Whether this registry is active |
| `provider` | string | `"static-index"` | Provider type (see [Registry Providers](#registry-providers)) |
| `options` | object | -- | Provider-specific options (passed through to the provider) |

Set `enabled: false` to temporarily disable a registry without removing it.

## Searching Registries

Search registries alongside or instead of the local stash:

```bash
# Search registries only
akm search "deploy" --source registry

# Search both local stash and registries
akm search "deploy" --source both

# Search registries directly via the registry subcommand
akm registry search "deploy"

# Include asset-level results from v2 indexes
akm registry search "deploy" --assets
```

### Search Results

Each registry hit includes:

| Field | Description |
| --- | --- |
| `type` | Always `"registry"` |
| `name` | Kit display name |
| `id` | Unique identifier (e.g. `npm:@scope/kit`) |
| `description` | Summary from the registry |
| `action` | Ready-to-run next step such as `akm add ... -> then search again` |
| `curated` | Whether the entry was manually reviewed |

Use `--detail full` to include ranking metadata like `score`.

### The `--assets` Flag

When a registry publishes a v2 index (see below), `akm registry search` can
return individual asset-level hits in addition to kit-level hits. Pass
`--assets` to enable this:

```bash
akm registry search "code review" --assets
```

Asset hits include `assetType`, `assetName`, `description`, and the parent
`kit` information, so you can install the right kit and immediately know
which asset to use.

## Discovery Filtering

Not every npm package or GitHub repo is an akm kit. To keep results
relevant, the registry enforces tag-based filtering:

- **npm** -- Only packages whose `keywords` array includes `"akm"` or
  `"agentikit"` appear in search results.
- **GitHub** -- Only repositories with the topic `akm` or `agentikit`
  appear in search results.

If you are publishing a kit, add these tags so it can be discovered:

```jsonc
// package.json
{
  "keywords": ["akm", "your-other-tags"]
}
```

For GitHub repos, add topics via the repository settings page or the
`gh repo edit --add-topic` command.

## Installing

Install a kit with `akm add` using any supported ref format:

```bash
# npm package
akm add npm:@scope/my-kit

# npm package (shorthand)
akm add @scope/my-kit

# GitHub repo
akm add github:owner/repo

# GitHub repo at a specific tag or branch
akm add github:owner/repo#v1.2.0

# GitHub URL
akm add https://github.com/owner/repo

# Any git repo (GitLab, Bitbucket, Gitea, self-hosted, etc.)
akm add git+https://gitlab.com/org/kit
akm add git+https://gitlab.com/org/kit#v1.0
akm add git+ssh://git@gitlab.com/org/kit.git

# Non-GitHub https URLs are automatically treated as git repos
akm add https://gitlab.com/org/my-kit

# Local directory (path or file: URI)
akm add ./path/to/local/kit
akm add file:../relative/kit
akm add file:///absolute/path/to/kit
```

### What Happens During Install

1. **Ref parsing** -- The ref is classified as npm, GitHub, git, or local
   directory.
2. **Artifact resolution** -- For npm, the latest (or requested) version
   tarball URL is resolved. For GitHub, the latest release tarball is used, or
   the default branch if no releases exist. For git, the repo is shallow-cloned.
3. **Download and extract** -- The tarball is downloaded (or repo cloned) to a
   cache directory under `~/.cache/akm/registry/` and extracted securely
   (path traversal is rejected).
4. **Stash root detection** -- The extracted contents are scanned for asset
   type directories (`scripts/`, `skills/`, etc.) or a `.stash/` marker. If the
   kit nests its stash under an `opencode/` subdirectory, that is detected
   automatically.
5. **Selective include** -- If the package's `package.json` contains an
   `akm.include` array, only the listed paths are copied into the
   install cache. This lets a kit ship a subset of its repo as the stash.
6. **Config registration** -- The installed entry is saved to
   `config.installed` with its id, source, ref, resolved version,
   cache path, and install timestamp.
7. **Re-index** -- `akm index` runs automatically so the new assets appear in
   search immediately.

### Selective Include

A kit can declare which paths to include via `package.json`:

```jsonc
{
  "akm": {
    "include": [
      "scripts",
      "skills",
      "commands"
    ]
  }
}
```

Only the listed paths are copied into the install cache. Paths must be
relative to the package root and cannot escape it. The `.git` directory is
always excluded.

## Managing Installed Kits

```bash
# List all installed kits with their status
akm list

# Update a specific kit to its latest version
akm update npm:@scope/my-kit

# Update all installed kits
akm update --all

# Force fresh download even if version is unchanged
akm update npm:@scope/my-kit --force
akm update --all --force

# Remove a kit
akm remove npm:@scope/my-kit
```

### Cloning Assets

Installed kits are cache-managed and may be overwritten by `akm update`.
To edit an asset from an installed kit, clone it into the working stash:

```bash
akm clone "npm:@scope/my-kit//script:deploy.sh"

# Clone with a new name
akm clone "npm:@scope/my-kit//script:deploy.sh" --name my-deploy.sh
```

The cloned asset lives in the working stash and takes priority over the
installed version in search and show.

Use `--dest` to clone to a custom directory instead of the working stash:

```bash
# Deploy a script directly into a project's .claude directory
akm clone "npm:@scope/my-kit//script:deploy.sh" --dest ./project/.claude
```

The type subdirectory (`scripts/`, `skills/`, etc.) is appended automatically,
so the example above produces `./project/.claude/scripts/deploy.sh`.

**Remote clone without install:** If the origin in the ref points to a
package that is not yet installed, `akm clone` fetches it to the cache
automatically. Unlike `akm add`, this does **not** register the package as
an installed kit -- it only extracts the single requested asset.

## Source Priority

When multiple sources provide the same asset name, the first match wins:

1. **Primary stash** -- `AKM_STASH_DIR`
2. **Search paths** -- Additional directories from config (`searchPaths`)
3. **Installed packages** -- Registry kits from `akm add` (cache-managed)

This means local edits and clones always override installed versions.

## Registry Providers

akm uses a pluggable provider system for registries. Each registry entry can
specify a `provider` type that determines how it is searched. When omitted,
the provider defaults to `"static-index"` (the original behavior).

### Built-in Providers

#### `static-index` (default)

Fetches a static JSON index from the configured URL and performs client-side
scoring. This is the original registry behavior. The index is cached locally
with a 1-hour TTL and a 7-day stale fallback.

```bash
akm registry add https://example.com/registry/index.json --name my-team
```

#### `skills-sh`

Searches the [skills.sh](https://skills.sh) registry using its server-side
search API. Results are skills from GitHub repositories indexed by skills.sh.

```bash
akm registry add https://skills.sh --name skills.sh --provider skills-sh
```

Key behaviors:
- Server-side search via `GET {url}/api/search?q={query}&limit={limit}`
- Results are mapped to `RegistrySearchHit` with source `"github"`
- Hit IDs are namespaced with `"skills-sh:"` prefix to avoid collisions
- Scores are normalized from install counts (0-1 range)
- Per-query response caching with 15-minute TTL
- Stale cache fallback (up to 24 hours) on network failure
- No authentication required

To install a skill found via skills.sh, use the `ref` field (GitHub
`owner/repo`) with `akm add`:

```bash
akm add vercel-labs/agent-skills
```

### Implementing a Custom Provider

Each provider is a TypeScript class implementing the `RegistryProvider`
interface:

```ts
interface RegistryProvider {
  readonly type: string;
  search(options: RegistryProviderSearchOptions): Promise<RegistryProviderResult>;
}

interface RegistryProviderSearchOptions {
  query: string;
  limit: number;
  includeAssets?: boolean;
}

interface RegistryProviderResult {
  hits: RegistrySearchHit[];
  assetHits?: RegistryAssetSearchHit[];
  warnings?: string[];
}
```

Contract:
- `search()` must never throw. Catch errors internally and return them as
  `warnings[]`.
- `limit` is always in the range `[1, 100]`.
- Return `hits` sorted by relevance. The orchestrator performs a final
  merge-sort across providers.

To register a provider, create a file in `src/providers/` and call
`registerProvider()` at module scope:

```ts
import { registerProvider } from "../provider-registry";

class MyProvider implements RegistryProvider {
  readonly type = "my-provider";
  // ...
}

registerProvider("my-provider", (config) => new MyProvider(config));
```

Then import the file in `src/registry-search.ts` to trigger self-registration.

### Future Provider Candidates

| Provider | API | Notes |
| --- | --- | --- |
| ClawdHub | `https://clawhub.com` | OpenClaw/Clawdbot skill registry with vector search |
| LobeHub | `https://lobehub.com/skills/` | Skills marketplace with reviews |
| npm keyword | `https://registry.npmjs.org/-/v1/search` | Real-time npm search by keyword |
| GitHub topic | GitHub API `search/repositories` | Live search by topic |

## Hosting Your Own Registry

A registry is a static JSON file conforming to the registry index schema.
You can host one on any static file server, CDN, or GitHub Pages.

Minimal example:

```json
{
  "version": 2,
  "updatedAt": "2026-03-12T00:00:00Z",
  "kits": [
    {
      "id": "github:your-org/deploy-kit",
      "name": "deploy-kit",
      "description": "Deployment scripts and skills",
      "ref": "your-org/deploy-kit",
      "source": "github",
      "tags": ["deploy", "infrastructure"],
      "assetTypes": ["script", "skill"]
    }
  ]
}
```

Host the file at a stable URL and have team members add it:

```bash
akm registry add https://your-server.com/akm-registry/index.json --name team
```

To generate the index automatically, consider the tooling in the
[akm-registry](https://github.com/itlackey/akm-registry) repository used by the
official registry.

## Registry Index v2

Version 2 of the registry index schema adds an optional `assets` array to
each kit entry. This enables asset-level search without installing the kit
first.

```json
{
  "version": 2,
  "updatedAt": "2026-03-12T00:00:00Z",
  "kits": [
    {
      "id": "npm:@scope/my-kit",
      "name": "my-kit",
      "description": "Scripts and skills for deployment",
      "ref": "@scope/my-kit",
      "source": "npm",
      "tags": ["deploy"],
      "assetTypes": ["script", "skill"],
      "assets": [
        { "type": "script", "name": "deploy.sh", "description": "Deploy to production" },
        { "type": "skill", "name": "code-review", "description": "Structured code review process" }
      ]
    }
  ]
}
```

Each asset entry supports:

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | Asset type (`script`, `skill`, `command`, `agent`, `knowledge`) |
| `name` | yes | Asset name |
| `description` | no | One-line summary |
| `tags` | no | Searchable keywords |

v1 indexes (without `assets`) remain fully supported. akm treats the
`version` field as forward-compatible: unknown fields are ignored.

## Cache Layout

Installed kits are cached under `~/.cache/akm/registry/`:

```
~/.cache/akm/registry/
  npm-@scope-my-kit/
    <timestamp>-<random>/
      artifact.tar.gz     # Downloaded archive
      extracted/           # Extracted contents
      selected/            # Subset from akm.include (if applicable)
```

Each install creates a new timestamped directory. Previous versions are
cleaned up automatically when a kit is updated.
