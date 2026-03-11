# Registry

The registry is how akm finds and installs kits from external sources. Kits
are collections of assets (tools, skills, commands, agents, knowledge, scripts)
published to npm or hosted on GitHub.

## Discovery

`akm search` can query external registries alongside the local stash:

```bash
# search local stash only (default)
akm search "deploy"

# search registries only
akm search "deploy" --source registry

# search both local and registries
akm search "deploy" --source both
```

Registry search queries npm and GitHub in parallel.

### Filtering

Not every npm package or GitHub repo is an agentikit kit. To keep results
relevant, the registry enforces tag-based filtering:

- **npm** -- Only packages whose `keywords` array in `package.json` includes
  `"akm"` or `"agentikit"` appear in search results.
- **GitHub** -- Only repositories with the topic `akm` or `agentikit` appear
  in search results.

If you are publishing a kit, add these tags so it can be discovered:

```jsonc
// package.json
{
  "keywords": ["akm", "your-other-tags"]
}
```

For GitHub repos, add topics via the repository settings page or the
`gh repo edit --add-topic` command.

### Search Results

Each registry hit includes:

| Field | Description |
| --- | --- |
| `source` | `"npm"` or `"github"` |
| `id` | Unique identifier (e.g. `npm:@scope/kit`) |
| `ref` | The value you pass to `akm add` |
| `title` | Package or repo name |
| `description` | Summary from the registry |
| `score` | Relevance (npm) or star count (GitHub) |
| `installRef` | Ready-to-use ref for `akm add` |
| `installCmd` | Full install command string |

## Installing

Install a kit with `akm add` using any supported ref format:

```bash
# npm package
akm add npm:@scope/my-kit

# npm package (shorthand -- bare name, resolved as npm if it doesn't look like owner/repo)
akm add @scope/my-kit

# GitHub repo
akm add github:owner/repo

# GitHub repo at a specific tag or branch
akm add github:owner/repo#v1.2.0

# GitHub URL
akm add https://github.com/owner/repo

# Any git repo (GitLab, Bitbucket, Gitea, self-hosted, etc.)
akm add git+https://gitlab.com/org/my-kit
akm add git+https://gitlab.com/org/my-kit#v1.0
akm add git+ssh://git@gitlab.com/org/my-kit.git

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
   cache directory under `~/.cache/agentikit/registry/` and extracted securely
   (path traversal is rejected).
4. **Stash root detection** -- The extracted contents are scanned for asset
   type directories (`tools/`, `skills/`, etc.) or a `.stash/` marker. If the
   kit nests its stash under an `opencode/` subdirectory, that is detected
   automatically.
5. **Selective include** -- If the package's `package.json` contains an
   `agentikit.include` array, only the listed paths are copied into the
   install cache. This lets a kit ship a subset of its repo as the stash.
6. **Config registration** -- The installed entry is saved to
   `config.registry.installed` with its id, source, ref, resolved version,
   cache path, and install timestamp.
7. **Re-index** -- `akm index` runs automatically so the new assets appear in
   search immediately.

### Selective Include

A kit can declare which paths to include via `package.json`:

```jsonc
{
  "agentikit": {
    "include": [
      "tools",
      "skills",
      "commands"
    ]
  }
}
```

Only the listed paths are copied into the install cache. Paths must be
relative to the package root and cannot escape it. The `.git` directory is
always excluded.

## Auto-Install on Open

When you open an asset ref that includes an origin pointing to a registry
package (`origin//type:name`) but the package is not yet installed,
akm reports the missing kit with an install command. Refs from
search results work without a separate install step:

```bash
# If not installed, akm will suggest: akm add npm:@scope/my-kit
akm show "npm:@scope/my-kit//script:deploy.sh"
```

The origin in the ref is used to determine what to install. After installation,
stash sources are re-resolved and the asset lookup is retried.

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

The type subdirectory (`tools/`, `skills/`, etc.) is appended automatically,
so the example above produces `./project/.claude/tools/deploy.sh`.

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

## Submitting a Kit to the Registry

Kit submission via CLI is planned for a future release. In the meantime, you
can submit kits by opening a pull request directly against the
[akm-registry](https://github.com/itlackey/akm-registry) repository.

## Cache Layout

Installed kits are cached under `~/.cache/agentikit/registry/`:

```
~/.cache/agentikit/registry/
  npm-@scope-my-kit/
    <timestamp>-<random>/
      artifact.tar.gz     # Downloaded archive
      extracted/           # Extracted contents
      selected/            # Subset from agentikit.include (if applicable)
```

Each install creates a new timestamped directory. Previous versions are
cleaned up automatically when a kit is updated.
