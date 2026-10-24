# Registry

A registry is a searchable list of bundles that `akm` can discover and install
from. The default registry type is a static JSON index; akm also has a
`skills-sh` provider for [skills.sh](https://skills.sh).

## Official registry

akm ships with the official registry configured:

```text
https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json
```

The [akm-registry](https://github.com/itlackey/akm-registry) repo publishes a
static `index.json` built from three sources:

- npm packages with the `akm-stash` keyword
- GitHub repos with the `akm-stash` topic
- `manual-entries.json` for curated additions and overrides

To get a bundle listed, tag your package or repo with `akm-stash` (add it to
`keywords` in `package.json`, or to the repository topics) or open a pull
request against `manual-entries.json`.

### Official onboarding bundle

[itlackey/akm-stash](https://github.com/itlackey/akm-stash) ships skills,
commands, knowledge, workflows and a librarian subagent for working with akm
itself:

```sh
akm bundle add github:itlackey/akm-stash
akm index
akm show skills/akm-quickstart
```

## Managing registries

```sh
akm registry list
akm registry add https://example.com/registry/index.json --name my-team
akm registry remove my-team
```

Registries are stored in the `registries` array of `config.json`:

```jsonc
{
  "registries": [
    { "url": "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json", "name": "akm-registry" },
    { "url": "https://example.com/registry/index.json", "name": "my-team" },
    { "url": "https://skills.sh", "name": "skills.sh", "provider": "skills-sh", "enabled": true }
  ]
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string | (required) | URL of the registry index or API base |
| `name` | string | none | Label |
| `enabled` | boolean | `true` | Set `false` to keep the entry but skip it when searching |
| `provider` | string | `static-index` | `static-index` or `skills-sh` |
| `options` | object | none | Provider-specific options |

A registry URL with a username or password is dropped with a warning, and the
built-in providers send no credentials; host the index at a credential-free
HTTPS URL. A plain `http://` URL needs `--allow-insecure-transport` on
`akm registry add`.

### Enabling skills.sh

The skills.sh entry ships in the default registries with `enabled: false`.
`akm registry add` does nothing for a URL that is already configured, so it
does not turn the entry on. To enable it, remove the entry and add it again:

```sh
akm registry remove skills.sh
akm registry add https://skills.sh --name skills.sh --provider skills-sh
```

You can also set `"enabled": true` on the entry in `config.json` (`akm config
path` prints its location), or tick it in the `akm setup` wizard. To turn it
off again, set `"enabled": false`, or run `akm registry remove skills.sh`.

## Searching registries

```sh
akm search "deploy" --from registry     # registries only
akm search "deploy" --from all          # local bundles and registries
```

Registry hits come back in `registryHits`, separate from local `hits`. Fields
by `--detail` level:

| Level | Fields |
| --- | --- |
| `brief` | `name`, `score` |
| `normal` | `name`, `description`, `action`, `score`, and `warnings` when present |
| `full` | the whole hit: `type`, `name`, `id`, `description`, `action`, `score`, `registryName`, and `warnings` when present |

`action` holds the install command, for example
`akm bundle add github:itlackey/akm-stash -> then search again`. Registry
scores are normalized to 0 to 1 within each registry's results; compare them
only within one registry, never with local scores. `--assets` is accepted but
`akm search` does not currently print asset-level registry hits.

## Installing

Install a bundle with `akm bundle add` using any supported ref:

```sh
akm bundle add npm:@scope/my-bundle            # npm package
akm bundle add @scope/my-bundle                # npm shorthand
akm bundle add github:owner/repo               # GitHub repo
akm bundle add github:owner/repo#v1.2.0        # at a tag or branch
akm bundle add https://github.com/owner/repo   # GitHub URL
akm bundle add git+https://gitlab.com/org/bundle#v1.0
akm bundle add git+ssh://git@gitlab.com/org/bundle.git
akm bundle add ./path/to/local/bundle          # local directory (or file: URI)
```

URLs on known git hosts and `.git` URLs are git sources; other `http(s)` URLs
are website sources (see [Website sources](website-sources.md)).

What `bundle add` does:

1. Fetches the package or repo into `$CACHE/registry/` (git refs prefer a
   shallow clone; GitHub tarballs are the fallback).
2. Stops if a `.env` file in the bundle sets a process-hijacking variable such
   as `LD_PRELOAD` or `PATH`. On a terminal it asks for confirmation; without
   one it fails unless you pass `--allow-dangerous-env-keys`.
3. Finds the bundle root: the package root when it looks like a bundle in any
   layout akm recognizes (see [Bundle types](bundle-types.md)), otherwise the
   shallowest nested directory that does. If the package's `package.json` has
   an `akm.include` array, only those paths are copied.
4. Saves the source to `bundles` in `config.json`, records the resolved version
   and revision in `akm.lock` under the data directory, and re-indexes.

```jsonc
{ "akm": { "include": ["scripts", "skills", "commands"] } }   // package.json
```

`include` paths are relative to the package root.

### Managing installed bundles

```sh
akm bundle list
akm bundle update npm:@scope/my-bundle
akm bundle update --all
akm bundle update --all --force      # re-download even if the version is unchanged
akm bundle remove npm:@scope/my-bundle
```

### Cloning assets

Installed bundles are cache-managed and `akm bundle update` can overwrite
them. To edit an asset, clone it into your working bundle:

```sh
akm clone "npm:@scope/my-bundle//scripts/deploy.sh"
akm clone "npm:@scope/my-bundle//scripts/deploy.sh" --name my-deploy.sh
akm clone "npm:@scope/my-bundle//scripts/deploy.sh" --dest ./project/.claude
```

`--dest` copies into a directory instead of a bundle; the type directory is
appended, so the last example writes `./project/.claude/scripts/deploy.sh`. If
the origin in the ref is not installed, `clone` fetches it to the cache and
extracts the one asset without adding the package as a bundle.

A short ref such as `scripts/deploy.sh` resolves against the default bundle
first, then the other bundles in installation-priority order, so `akm show`
finds your clone before the upstream copy. Qualify a ref as
`bundle//conceptId` to pick a bundle explicitly. See [Refs](refs.md).

## Providers

Each registry entry names a `provider`; the default is `static-index`.
Registries only list installable bundles. They never hold asset content.
Installing a bundle creates a regular `bundles` entry.

### `static-index`

Fetches a static JSON index from the registry URL and scores it client-side.
The index is cached for 1 hour.

### `skills-sh`

Searches skills.sh through its server-side API
(`GET {url}/api/search?q={query}&limit={limit}`). Hit ids carry a `skills-sh:`
prefix (not installable; use the `akm bundle add` command in the hit's
`action`, which names the skill's GitHub repo). Scores are install counts
normalized to 0 to 1. Responses are cached per query for 15 minutes.

## Hosting your own registry

A registry is a static JSON file. Host it on any static file server, CDN or
GitHub Pages, then have your team add it with `akm registry add`.

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
      "assetTypes": ["script", "skill", "memory"]
    }
  ]
}
```

The only requirement is a `stashes` array. An entry needs `id`, `name`, `ref`
and a `source` of `npm`, `github`, `git` or `local`; entries missing one are
skipped. `description`, `homepage`, `tags`, `assetTypes`, `author`, `license`,
`latestVersion` and `assets` are optional, and unknown fields are ignored.
akm reads index versions 2 and 3 (they share this format) and warns once about
any other version.

To generate an index from npm, GitHub and a manual entries file, run the
maintainer script from the akm repository:

```sh
bun scripts/build-registry-index.ts --out dist/index.json
```

## Cache layout

Installed bundles are cached under `$CACHE/registry/` (default
`~/.cache/akm/registry/`):

```text
registry/
  npm-@scope-my-bundle/
    1.2.3/                 # resolved version, reused across installs
      artifact.tar.gz      # downloaded archive
      extracted/           # extracted contents
      selected/            # subset from akm.include, if any
```

The version directory is the resolved version for `npm` and `git` sources, or a
random id for `local` sources.
