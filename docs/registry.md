# Registry

A registry is a searchable source of stashes that `akm` can discover and
install from. The default registry type is a static JSON index, but akm
supports pluggable **registry providers** that can connect to different
ecosystems (e.g. skills.sh).

## Official Registry

akm ships with the official registry pre-configured:

```text
https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json
```

The [akm-registry](https://github.com/itlackey/akm-registry) repo publishes
a static `index.json` (v3 format). It merges three sources:

- npm packages with the `akm-stash` keyword
- GitHub repos with the `akm-stash` topic
- `manual-entries.json` for curated additions and overrides

To submit a stash, either tag your repo/package as above (auto-discovery)
or open a pull request against `manual-entries.json` for a curated entry.

### Official onboarding stash

In addition to the registry, akm has an official onboarding stash —
[itlackey/akm-stash](https://github.com/itlackey/akm-stash) — that ships
skills, commands, knowledge, workflows, and a librarian subagent for
working with akm itself. Install it with:

```bash
akm add github:itlackey/akm-stash
akm index
akm show skill:akm-quickstart
```

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

# Include asset-level results from v3 indexes
akm registry search "deploy" --assets
```

### Search Results

Each registry hit includes:

| Field | Description |
| --- | --- |
| `type` | Always `"registry"` |
| `name` | Stash display name |
| `id` | Unique identifier (e.g. `npm:@scope/stash`) |
| `description` | Summary from the registry |
| `action` | Ready-to-run next step such as `akm add ... -> then search again` |
| `quality` | Optional provenance marker — `"generated"`, `"curated"`, or `"proposed"`. Replaces the legacy `curated` boolean removed in 0.7.0 |

Use `--detail full` to include ranking metadata like `score`.

### The `--assets` Flag

When a registry publishes a v3 index (see below), `akm registry search` can
return individual asset-level hits in addition to stash-level hits. Pass
`--assets` to enable this:

```bash
akm registry search "code review" --assets
```

Asset hits include `assetType`, `assetName`, `description`, and the parent
`stash` information, so you can install the right stash and immediately know
which asset to use.

## Discovery Filtering

Not every npm package or GitHub repo is an akm stash. To keep results
relevant, the registry enforces tag-based filtering:

- **npm** -- Only packages whose `keywords` array includes `"akm-stash"` appear in search results.
- **GitHub** -- Only repositories with the topic `akm-stash` appear in search results.

> **0.6.0 breaking change:** `akm-cli >= 0.6.0` indexes only the
> `akm-stash` keyword / topic. The pre-0.6.0 `akm-kit` and `agentikit`
> keywords/topics are **not** honored as fallbacks. Publishers migrating
> from 0.5.x must add the new tag — see the
> [migration guide](migration/v0.5-to-v0.6.md) for the step-by-step
> publisher checklist.

If you are publishing a stash, add these tags so it can be discovered:

```jsonc
// package.json
{
  "keywords": ["akm-stash", "your-other-tags"]
}
```

For GitHub repos, add topics via the repository settings page or the
`gh repo edit --add-topic akm-stash` command.

## Installing

Install a stash with `akm add` using any supported ref format:

```bash
# npm package
akm add npm:@scope/my-stash

# npm package (shorthand)
akm add @scope/my-stash

# GitHub repo
akm add github:owner/repo

# GitHub repo at a specific tag or branch
akm add github:owner/repo#v1.2.0

# GitHub URL
akm add https://github.com/owner/repo

# Any git repo (GitLab, Bitbucket, Gitea, self-hosted, etc.)
akm add git+https://gitlab.com/org/stash
akm add git+https://gitlab.com/org/stash#v1.0
akm add git+ssh://git@gitlab.com/org/stash.git

# Non-GitHub https URLs are automatically treated as git repos
akm add https://gitlab.com/org/my-stash

# Local directory (path or file: URI)
akm add ./path/to/local/stash
akm add file:../relative/stash
akm add file:///absolute/path/to/stash
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
4. **Security audit** -- The extracted stash is audited before install completes.
   akm scans source files, metadata, prompts, and install scripts for suspicious
   patterns such as prompt-injection phrases, remote shell pipes, and risky
   lifecycle hooks. Critical findings block the install by default.
5. **Stash root detection** -- The extracted contents are scanned for asset
   type directories (`scripts/`, `skills/`, etc.) or a `.stash/` marker. If the
   stash nests its stash under an `opencode/` subdirectory, that is detected
   automatically.
6. **Selective include** -- If the package's `package.json` contains an
   `akm.include` array, only the listed paths are copied into the
   install cache. This lets a stash ship a subset of its repo as the stash.
7. **Config registration** -- The installed entry is saved to
   `config.installed` with its id, source, ref, resolved version,
   cache path, and install timestamp.
8. **Re-index** -- `akm index` runs automatically so the new assets appear in
   search immediately.

### Selective Include

A stash can declare which paths to include via `package.json`:

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

### Install Audit Controls

Install-time auditing is enabled by default. You can configure it in
`config.json` or via `akm config`:

```sh
akm config set security.installAudit.enabled false
akm config set security.installAudit.blockOnCritical false
akm config set security.installAudit.registryAllowlist '["npm","github.com"]'
akm config set security.installAudit.blockUnlistedRegistries true
```

- `security.installAudit.enabled` disables auditing entirely.
- `security.installAudit.blockOnCritical` reports critical findings without
  blocking the install when set to `false`.
- `security.installAudit.registryAllowlist` allows only named registries or
  hosts (for example `npm`, `github.com`, `gitlab.com`) when allowlisting is
  enabled.
- `security.installAudit.blockUnlistedRegistries` blocks installs whose source
  does not match the allowlist.

## Managing Managed Sources

```bash
# List all managed sources with their status
akm list

# Update a specific stash to its latest version
akm update npm:@scope/my-stash

# Update all managed sources
akm update --all

# Force fresh download even if version is unchanged
akm update npm:@scope/my-stash --force
akm update --all --force

# Remove a stash
akm remove npm:@scope/my-stash
```

### Cloning Assets

Managed sources are cache-managed and may be overwritten by `akm update`.
To edit an asset from a managed source, clone it into the working stash:

```bash
akm clone "npm:@scope/my-stash//script:deploy.sh"

# Clone with a new name
akm clone "npm:@scope/my-stash//script:deploy.sh" --name my-deploy.sh
```

The cloned asset lives in the working stash and takes priority over the
installed version in search and show.

Use `--dest` to clone to a custom directory instead of the working stash:

```bash
# Deploy a script directly into a project's .claude directory
akm clone "npm:@scope/my-stash//script:deploy.sh" --dest ./project/.claude
```

The type subdirectory (`scripts/`, `skills/`, etc.) is appended automatically,
so the example above produces `./project/.claude/scripts/deploy.sh`.

**Remote clone without install:** If the origin in the ref points to a
package that is not yet installed, `akm clone` fetches it to the cache
automatically. Unlike `akm add`, this does **not** register the package as
a managed source -- it only extracts the single requested asset.

## Search Priority

`akm search` and `akm show` query a single local FTS5 index that covers
every configured source's directory. There is no fixed lookup order —
results are ranked by relevance and utility, and precedence is expressed
through ranking rather than a per-source fan-out (see
[concepts.md](concepts.md#search-priority)).

When two sources contain an asset with the same name, the working stash
typically wins by convention because its files are usually more recent.
Use `akm clone` to copy an asset into your working stash for local
editing — your edits then override the upstream copy in subsequent
searches.

## Registry Providers

akm uses a pluggable provider system for registries. Each registry entry can
specify a `provider` type that determines how it is searched. When omitted,
the provider defaults to `"static-index"`.

Registries discover *kits* (installable source bundles). They never store
asset content directly — installing a kit creates a regular `sources[]`
entry that the indexer walks like any other source.

### Built-in Providers

#### `static-index` (default)

Fetches a static JSON v3 index from the configured URL and performs
client-side scoring. The index is cached locally with a 1-hour TTL and a
7-day stale fallback.

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
- Hit IDs are namespaced with `"skills-sh:"` prefix to avoid collisions
- Scores are normalized from install counts (0-1 range)
- Per-query response caching with 15-minute TTL
- Stale cache fallback (up to 24 hours) on network failure
- No authentication required
- Toggle on/off via `akm enable skills.sh` / `akm disable skills.sh`

To install a skill found via skills.sh, use the `ref` field (GitHub
`owner/repo`) with `akm add`:

```bash
akm add vercel-labs/agent-skills
```

## Hosting Your Own Registry

A registry is a static JSON file conforming to the registry index schema.
You can host one on any static file server, CDN, or GitHub Pages.

Minimal example:

```json
{
  "version": 3,
  "updatedAt": "2026-03-12T00:00:00Z",
  "stashes": [
    {
      "id": "github:your-org/deploy-stash",
      "name": "deploy-stash",
      "description": "Deployment scripts and skills",
      "ref": "your-org/deploy-stash",
      "source": "github",
      "tags": ["deploy", "infrastructure"],
      "assetTypes": ["script", "skill", "memory"]
    }
  ]
}
```

Host the file at a stable URL and have team members add it:

```bash
akm registry add https://your-server.com/akm-registry/index.json --name team
```

To generate the index automatically, use the built-in `build-index` subcommand:

```bash
akm registry build-index --out dist/index.json
```

This scans the current directory for asset type directories and produces a v3
index with stash and asset entries. You can also use the tooling in the
[akm-registry](https://github.com/itlackey/akm-registry) repository used by the
official registry.

## Registry Index v3

Version 3 of the registry index schema is the only format `akm-cli >=
0.6.0` parses. It carries an `assets` array on each stash entry so
clients can perform asset-level search without installing the stash
first.

```json
{
  "version": 3,
  "updatedAt": "2026-03-12T00:00:00Z",
  "stashes": [
    {
      "id": "npm:@scope/my-stash",
      "name": "my-stash",
      "description": "Scripts and skills for deployment",
      "ref": "@scope/my-stash",
      "source": "npm",
      "tags": ["deploy"],
      "assetTypes": ["script", "skill", "memory"],
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
| `type` | yes | Any registered asset type (e.g. `script`, `skill`, `command`, `agent`, `knowledge`, `memory`, `workflow`, `vault`, `wiki`, `lesson`). The renderer registry is the authority — see v1 spec §4.1. |
| `name` | yes | Asset name |
| `description` | no | One-line summary |
| `tags` | no | Searchable keywords |

The 0.6.0 release dropped support for the legacy v1 / v2 indexes;
publishers must regenerate `index.json` with `akm registry build-index`
or the [akm-registry](https://github.com/itlackey/akm-registry) tooling
(see the [v0.5 → v0.6 migration guide](migration/v0.5-to-v0.6.md)). akm
treats unknown fields inside a v3 entry as forward-compatible.

## Cache Layout

Installed stashes are cached under `~/.cache/akm/registry/`:

```
~/.cache/akm/registry/
  npm-@scope-my-stash/
    <timestamp>-<random>/
      artifact.tar.gz     # Downloaded archive
      extracted/           # Extracted contents
      selected/            # Subset from akm.include (if applicable)
```

Each install creates a new timestamped directory. Previous versions are
cleaned up automatically when a stash is updated.
