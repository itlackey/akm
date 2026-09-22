# Registry

A registry is a searchable source of bundles that `akm` can discover and
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

To submit a bundle, either tag your repo/package as above (auto-discovery)
or open a pull request against `manual-entries.json` for a curated entry.

### Official onboarding bundle

In addition to the registry, akm has an official onboarding bundle —
[itlackey/akm-stash](https://github.com/itlackey/akm-stash) — that ships
skills, commands, knowledge, workflows, and a librarian subagent for
working with akm itself. Install it with:

```bash
akm bundle add github:itlackey/akm-stash
akm index
akm show skills/akm-quickstart
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

Registry URLs must be credential-free: AKM rejects URL userinfo such as
`https://user:password@example.com/index.json` before it can be saved. The
built-in `static-index` and `skills-sh` providers do not currently support
authenticated registry requests, including through `options`; publish the
index/API at a credential-free HTTPS endpoint or place an authenticated proxy
in front of it. AKM does not translate URL credentials into request headers.

Registry HTTP requests must also resolve to public network addresses. AKM
rejects loopback, private, link-local, metadata, and reserved destinations on
the initial URL and every redirect hop. This intentionally means a
`static-index` or `skills-sh` registry hosted only on localhost or an intranet
is no longer reachable in 0.9.2; publish it at a publicly routable HTTPS
endpoint. The only private-network compatibility exception is an npm mirror
explicitly selected with `AKM_NPM_REGISTRY`; metadata and tarball requests may
reach that configured mirror, but not link-local or cloud-metadata addresses.
See [Registry network boundary](../architecture/internals/registry-network-boundary.md)
for the complete policy and DNS guarantee.

## Searching Registries

Search registries alongside or instead of the local bundle:

```bash
# Search registries only
akm search "deploy" --from registry

# Search both the local bundle library and registries
akm search "deploy" --from all

# Include asset-level results from v3 indexes
akm search "deploy" --from registry --assets
```

### Search Results

Each registry hit includes:

| Field | Description |
| --- | --- |
| `type` | Always `"registry"` |
| `name` | Bundle display name |
| `id` | Unique identifier (e.g. `npm:@scope/bundle`) |
| `description` | Summary from the registry |
| `action` | Ready-to-run next step such as `akm bundle add ... -> then search again` |
| `quality` | Optional provenance marker — `"generated"`, `"curated"`, or `"proposed"`. Replaces the legacy `curated` boolean removed in 0.7.0 |

Use `--detail full` to include ranking metadata like `score`.

### The `--assets` Flag

When a registry publishes a v3 index (see below), `akm search --from
registry` can return individual asset-level hits in addition to bundle-level
hits. Pass `--assets` to enable this:

```bash
akm search "code review" --from registry --assets
```

Asset hits include `assetType`, `assetName`, `description`, and the parent
`stash` information, so you can install the right bundle and immediately know
which asset to use.

## Discovery Filtering

Not every npm package or GitHub repo is an akm bundle. To keep results
relevant, the registry enforces tag-based filtering:

- **npm** -- Only packages whose `keywords` array includes `"akm-stash"` appear in search results.
- **GitHub** -- Only repositories with the topic `akm-stash` appear in search results.

> **0.6.0 breaking change:** `akm-cli >= 0.6.0` indexes only the
> `akm-stash` keyword / topic. The pre-0.6.0 `akm-kit` and `agentikit`
> keywords/topics are **not** honored as fallbacks. Publishers migrating
> from 0.5.x must add the new tag — see the
> [migration guide](../migration/v0.5-to-v0.6.md) for the step-by-step
> publisher checklist.

If you are publishing a bundle, add these tags so it can be discovered:

```jsonc
// package.json
{
  "keywords": ["akm-stash", "your-other-tags"]
}
```

For GitHub repos, add topics via the repository settings page or the
`gh repo edit --add-topic akm-stash` command.

## Installing

Install a bundle with `akm bundle add` using any supported ref format:

```bash
# npm package
akm bundle add npm:@scope/my-bundle

# npm package (shorthand)
akm bundle add @scope/my-bundle

# GitHub repo
akm bundle add github:owner/repo

# GitHub repo at a specific tag or branch
akm bundle add github:owner/repo#v1.2.0

# GitHub URL
akm bundle add https://github.com/owner/repo

# Any git repo (GitLab, Bitbucket, Gitea, self-hosted, etc.)
akm bundle add git+https://gitlab.com/org/bundle
akm bundle add git+https://gitlab.com/org/bundle#v1.0
akm bundle add git+ssh://git@gitlab.com/org/bundle.git

# URLs on known git hosts are treated as git repos
akm bundle add https://gitlab.com/org/my-bundle

# Local directory (path or file: URI)
akm bundle add ./path/to/local/bundle
akm bundle add file:../relative/bundle
akm bundle add file:///absolute/path/to/bundle
```

### What Happens During Install

1. **Ref parsing** -- The ref is classified as npm, GitHub/git, website, or
   local directory. Known git hosts and `.git` URLs are git sources; other
   HTTP(S) URLs are website sources.
2. **Artifact resolution** -- For npm, the latest (or requested) version
   tarball URL is resolved. GitHub/git refs prefer a shallow clone at the
   resolved revision so normal git credentials work; GitHub API tarballs are a
   fallback when clone resolution is unavailable.
3. **Download and extract** -- The tarball is downloaded (or repo cloned) to a
   cache directory under `~/.cache/akm/registry/` and extracted securely
   (path traversal is rejected).
4. **Security audit** -- Before install completes, the extracted bundle's
   `env`/`secret` asset **key names** are checked against a denylist of
   process-execution-hijacking variables -- dynamic-linker hooks
   (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, ...), `PATH`, shell/runtime startup
   hooks (`BASH_ENV`, `PROMPT_COMMAND`, `NODE_OPTIONS`, `PYTHONSTARTUP`, ...),
   and interactive-tool overrides (`EDITOR`, `PAGER`, `GIT_SSH_COMMAND`, ...).
   `akm bundle add` **blocks the install** when a dangerous key is present unless
   `--allow-dangerous-env-keys` is set (or you confirm at an interactive prompt).
   This is a **key-name audit only** (plus the path-traversal rejection in step
   3) -- akm does **not** scan source files, prompts, metadata, or install
   scripts for prompt-injection phrases, shell pipes, or lifecycle hooks.
5. **Bundle root detection** -- The extracted contents are scanned for asset
   type directories (`scripts/`, `skills/`, etc.) or a `.stash/` marker. If the
   bundle nests its bundle under an `opencode/` subdirectory, that is detected
   automatically.
6. **Selective include** -- If the package's `package.json` contains an
   `akm.include` array, only the listed paths are copied into the
   install cache. This lets a bundle ship a subset of its repo as the bundle.
7. **Config registration** -- The desired source descriptor (`path`/`git`/
   `website`/`npm`, `writable`, the original `registryId`) is saved to
   `config.bundles.<key>`. Resolved cache state -- id, source, ref, resolved
   version/revision, integrity, local materialized root, and install
   timestamp -- is recorded separately in `<dataDir>/akm.lock`, never
   duplicated into `config.json`.
8. **Re-index** -- `akm index` runs automatically so the new assets appear in
   search immediately.

### Selective Include

A bundle can declare which paths to include via `package.json`:

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

## Managing Managed Sources

```bash
# List all managed sources with their status
akm bundle list

# Update a specific bundle to its latest version
akm bundle update npm:@scope/my-bundle

# Update all managed sources
akm bundle update --all

# Force fresh download even if version is unchanged
akm bundle update npm:@scope/my-bundle --force
akm bundle update --all --force

# Remove a bundle
akm bundle remove npm:@scope/my-bundle
```

### Cloning Assets

Managed sources are cache-managed and may be overwritten by `akm bundle update`.
To edit an asset from a managed source, clone it into the working bundle:

```bash
akm clone "npm:@scope/my-bundle//scripts/deploy.sh"

# Clone with a new name
akm clone "npm:@scope/my-bundle//scripts/deploy.sh" --name my-deploy.sh
```

The cloned asset lives in the working bundle and takes priority over the
installed version in search and show.

Use `--dest` to clone to a custom directory instead of the working bundle:

```bash
# Deploy a script directly into a project's .claude directory
akm clone "npm:@scope/my-bundle//scripts/deploy.sh" --dest ./project/.claude
```

The type subdirectory (`scripts/`, `skills/`, etc.) is appended automatically,
so the example above produces `./project/.claude/scripts/deploy.sh`.

**Remote clone without install:** If the origin in the ref points to a
package that is not yet installed, `akm clone` fetches it to the cache
automatically. Unlike `akm bundle add`, this does **not** register the package as
a managed source -- it only extracts the single requested asset.

## Search Priority

`akm search` and `akm show` query a single local FTS5 index that covers
every configured source's directory. There is no fixed lookup order —
results are ranked by relevance and utility, and precedence is expressed
through ranking rather than a per-source fan-out (see
[concepts.md](../guides/concepts.md#3-akm-builds-a-local-index-and-uses-progressive-disclosure)).

When two sources contain an asset with the same name, the working bundle
typically wins by convention because its files are usually more recent.
Use `akm clone` to copy an asset into your working bundle for local
editing — your edits then override the upstream copy in subsequent
searches.

## Registry Providers

akm uses a pluggable provider system for registries. Each registry entry can
specify a `provider` type that determines how it is searched. When omitted,
the provider defaults to `"static-index"`.

Registries discover installable source bundles. They never store
asset content directly — installing a bundle creates a regular `bundles`
entry that the indexer walks like any other source.

### Built-in Providers

#### `static-index` (default)

Fetches a static JSON v3 index from the configured URL and performs
client-side scoring. The index is cached locally with a 1-hour TTL. There is
currently no fallback to a stale cache row past that TTL on fetch failure —
`fetchCachedJson` (`src/storage/repositories/registry-cache.ts`) only
consults the cache row that its own `getRegistryIndexCache` lookup returned
under the same TTL, and that lookup returns nothing once the row is older
than `maxAgeMs`, so a fetch failure after the TTL expires surfaces as an
error rather than serving older data.

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
- No stale-cache fallback past that TTL on network failure — same shared
  cache mechanism as `static-index`, see the note there
- No authenticated-registry transport is currently supported
- Toggle on/off via `akm registry add https://skills.sh --name skills.sh --provider skills-sh` / `akm registry remove skills.sh` (the bare `akm enable` / `akm disable` aliases and `akm config enable|disable` were removed in 0.9.0 — use `akm registry add|remove`, the general mechanism)

To install a skill found via skills.sh, use the `ref` field (GitHub
`owner/repo`) with `akm bundle add`:

```bash
akm bundle add vercel-labs/agent-skills
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
      "id": "github:your-org/deploy-bundle",
      "name": "deploy-bundle",
      "description": "Deployment scripts and skills",
      "ref": "your-org/deploy-bundle",
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

To generate the index automatically, use the maintainer script in the akm
repository:

```bash
bun scripts/build-registry-index.ts --out dist/index.json
```

This does not scan the current directory. It fans out to three discovery
sources -- a manually curated `manual-entries.json`, an npm registry keyword
search for `akm-stash`, and a GitHub topic search for `akm-stash` -- and
deduplicates the results into a v3 index with bundle and asset entries. You
can also use the tooling in the
[akm-registry](https://github.com/itlackey/akm-registry) repository used by the
official registry.

## Registry Index v3

Version 3 of the registry index schema is the only format `akm-cli >=
0.6.0` parses. It carries an `assets` array on each bundle entry so
clients can perform asset-level search without installing the bundle
first.

```json
{
  "version": 3,
  "updatedAt": "2026-03-12T00:00:00Z",
  "stashes": [
    {
      "id": "npm:@scope/my-bundle",
      "name": "my-bundle",
      "description": "Scripts and skills for deployment",
      "ref": "@scope/my-bundle",
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
| `type` | yes | AKM's own asset type keys (`skill`, `command`, `agent`, `knowledge`, `workflow`, `script`, `memory`, `env`, `secret`, `lesson`, `task`, `session`, `fact`, `instruction` — the authority is `KNOWN_TYPES` in `src/core/recognition-util.ts`), or a foreign/adapter-owned type (e.g. an `llm-wiki` page kind). This field is not a strict validation gate, so an unrecognized type still round-trips. Note: `wiki` was retired as an AKM-owned type — the LLM Wiki structure now lives in the first-class `llm-wiki` adapter, whose page kinds are foreign types rather than an AKM-owned `wiki` type. |
| `name` | yes | Asset name |
| `description` | no | One-line summary |
| `tags` | no | Searchable keywords |

The 0.6.0 release dropped support for the legacy v1 / v2 indexes;
publishers must regenerate `index.json` with the
`scripts/build-registry-index.ts` maintainer script
or the [akm-registry](https://github.com/itlackey/akm-registry) tooling
(see the [v0.5 → v0.6 migration guide](../migration/v0.5-to-v0.6.md)). akm
treats unknown fields inside a v3 entry as forward-compatible.

## Cache Layout

Installed bundles are cached under `~/.cache/akm/registry/`
(`buildInstallCacheDir`, `src/sources/providers/provider-utils.ts`):

```
~/.cache/akm/registry/
  npm-@scope-my-bundle/
    1.2.3/                 # the resolved version — reused across installs
      artifact.tar.gz      # Downloaded archive
      extracted/           # Extracted contents
      selected/             # Subset from akm.include (if applicable)
```

The version segment is the resolved version string for `npm`/`git` sources
(so re-installing the same version reuses the cache), or a random UUID for
`local` sources, which are always isolated per install.
