# Bundles

akm works toward two outcomes: bring the agent assets you already have into
one library, and install (or share) reusable capability bundles with other
people. Both go through the same primitive, a **bundle**, which can be a
local directory, a git repo, an npm package, or a crawled website.
**Registries** are discovery indexes that let you find bundles you haven't
heard of yet. Together they give you a unified, searchable library that pulls
from anywhere and grows over time.

## Bring what you already have into one library

If you already have skills, commands, or agent configs scattered across
different tools, point akm at each of them. Nothing moves: akm indexes assets
in place, and every asset becomes retrievable through the same search and
curate commands regardless of which agent originally created it.

```sh
akm bundle add ~/.claude               # Claude Code's project/user assets
akm bundle add ~/.config/opencode      # OpenCode's config directory
akm curate "plan a release"            # Pull the best matches from every bundle you added
```

This is the "one library for every agent" idea in practice: assets authored
for one tool become discoverable, and usable, from any other.

## akm bundle add

`akm bundle add` connects a new bundle and indexes it. The source kind is
inferred from the input: known git hosts and URLs ending in `.git` are git
bundles, while other HTTP(S) URLs are website bundles.

```sh
akm bundle add ~/.claude/skills                          # Local directory (filesystem)
akm bundle add github:owner/team-bundle                  # GitHub repo (git)
akm bundle add @scope/bundle                              # npm package
akm bundle add npm:@scope/bundle@latest                  # npm with version pin
akm bundle add github:owner/repo#v1.2.3                 # GitHub at a specific tag
akm bundle add https://docs.example.com --name docs     # Crawled website (website)
akm bundle add https://docs.example.com --max-pages 200 --max-depth 5

# Add the official onboarding bundle:
akm bundle add github:itlackey/akm-stash

# Mark a git bundle as writable (enables akm sync to push):
akm bundle add git@github.com:org/skills.git --provider git --name my-skills --writable

# Authenticate an HTTPS Git bundle without storing a token in its URL:
GIT_READ_TOKEN=... akm bundle add https://github.com/org/private.git --provider git \
  --name private --credential '$GIT_READ_TOKEN'

# Control secondary-bundle resolution priority (the default bundle is always first):
akm bundle add github:owner/team-bundle --name team --before community
```

| Bundle kind | Input shape | Behavior |
| --- | --- | --- |
| `filesystem` | local path | Indexed in place, writable by default |
| `git` | `github:`, known git-host URL, or URL ending in `.git` | Cloned into the akm cache, read-only by default |
| `npm` | `@scope/pkg` | Installed into the akm cache, read-only |
| `website` | Other HTTP/HTTPS URL | Crawled into the akm cache and converted to markdown, read-only |

**Bundle naming.** `--name` sets the bundle's key; akm's config, index, and
every persisted ref hang off it. It must be a legal bundle slug (no `:` `.`
`#` `/` or whitespace), and it must not already be taken by a different
bundle, or the add fails before writing anything. Re-adding a source that is
already installed under a different `--name` also fails, naming the existing
key; use [`akm bundle rename`](#akm-bundle-rename) to relabel it. Every
`akm bundle add` result carries `bundleId`, the resolved key. Without `--name`,
akm derives one (the directory name, the package or repo name, or the
hostname), adding a `-<hash>` suffix only on a collision.

Git credentials are given as a reference, `$VAR`, `${VAR}`, or
`secret://name`, never as a literal token; akm resolves it when it runs git and
does not write it to the remote URL or `config.json`. A plain `http://` source
URL (other than localhost) needs `--allow-insecure-transport`.

If a bundle's `env/` files set variable names such as `LD_PRELOAD`, `PATH` or
`NODE_OPTIONS` (41 names plus the `BASH_FUNC_*` and `GIT_CONFIG_*` prefixes;
`akm lint` reports the same ones), `akm bundle add` and `akm bundle update` ask
before continuing in a terminal and stop in a non-interactive run unless you
pass `--allow-dangerous-env-keys`.

Installing a bundle makes its scripts, prompts and workflows available to your
agent. A website sync (and `akm import <url>`) also imports and runs every
`.ts`, `.js` or `.mjs` module in your working bundle's
`scripts/wiki-fetchers/` directory as a custom fetcher.

**Website bundles.** A `website` URL is offered to a set of specialized
fetchers (YouTube, Bluesky, X, RSS/Atom feeds) before falling back to a
general crawl, and crawl behavior (page/depth limits, timeouts, robots.txt)
is configurable. See the
[website source recipe](recipes/website-source.md) for a walkthrough and
[Website Sources](../reference/website-sources.md) for the full fetcher
reference, X credential setup, and crawl-option details. Low-level knobs like
`crawlTimeoutMs` and `respectRobots` live in the bundle's `website`
descriptor; see [Configuration](../reference/configuration.md).

**Example: add a team bundle from GitHub**

```sh
akm bundle add github:my-org/team-bundle --name team
akm search "deploy" --type script
```

## akm bundle list

`akm bundle list` shows all configured bundles (local directories, managed
packages, and remote providers) so you know what is in your library.

```sh
akm bundle list                          # All bundles
akm bundle list --kind filesystem        # Only local directories
akm bundle list --kind git               # Only git-cloned bundles
akm bundle list --kind npm               # Only npm packages
akm bundle list --kind filesystem,git    # Multiple kinds (comma-separated)
```

Valid `--kind` values are the four bundle providers: `filesystem`, `git`,
`npm`, `website`.

## akm bundle update / akm bundle remove

`akm bundle update` re-fetches git, npm, and website bundles into a staging
directory, then publishes and indexes the result. `akm bundle remove`
disconnects a bundle and re-indexes without it.

Nothing refreshes on a timer. A bundle is fetched when you add it and when you
run `akm bundle update`. `akm index` fetches a bundle only if it has never been
materialized on this host, such as a website or a `--provider git` bundle in a
config you copied to a new machine; it does not re-fetch a bundle that is
already there, however old. For a git, GitHub or npm install whose files are
missing, `akm index` warns and names `akm bundle update` instead of fetching. An
npm bundle in config with no lock entry (for example a config copied to a new
machine) is skipped with the same warning; `akm bundle update` installs it.
To refresh on a schedule, schedule `akm bundle update --all --skip-if-locked`,
where `--skip-if-locked` turns database contention with a concurrent index or
improve run into a successful skip instead of exit 75.

```sh
# Update
akm bundle update @scope/bundle          # One managed bundle
akm bundle update --all                 # All managed bundles
akm bundle update --all --force         # Force fresh download even if version unchanged
akm bundle update --all --skip-if-locked # Scheduled refresh: exit 0 on DB contention
akm bundle update @scope/bundle --allow-dangerous-env-keys  # Proceed past dangerous env keys

# Remove
akm bundle remove @scope/bundle          # By npm id
akm bundle remove github:owner/repo     # By git ref
akm bundle remove ~/.claude/skills      # By path
akm bundle remove my-provider           # By name
```

With `--all`, a bundle that fails or is blocked is reported and the rest
continue; a failed bundle keeps its previous contents and index. If an update
is interrupted, rerun `akm bundle update <name>`, then `akm health`, and
`akm index --full` if health reports an index or state mismatch.

New bundles get a `.gitignore` that keeps `env/` and `secrets/` out of git. A
private bundle that versions them on purpose can put
`# akm: intentionally track env and secrets` anywhere in its root `.gitignore`
and akm leaves the file alone.

**Example: keep bundles fresh**

```sh
akm bundle update --all
```

## akm bundle rename

`akm bundle rename <old> <new>` is the one command allowed to change a
configured bundle's key. A bundle id prefixes every ref akm has stored (index
entries, proposals, workflow history, `scheduler.enabled`), so editing the
`bundles` key in `config.json` by hand leaves all of those pointing at the old
name.

```sh
akm bundle rename old-name new-name --dry-run   # See the plan first
akm bundle rename old-name new-name
```

`<new>` must be a legal, unused bundle slug, the same rule `akm bundle add
--name` enforces. The rename rewrites the config key, `defaultBundle` and
`defaultWriteTarget` when they name the old id, scheduler refs, the lockfile
entry, indexed entries, and akm's own state rows, and re-syncs native
scheduler bindings under the new name (`taskSync.ok` is `false` when a binding
fails to re-sync). Refs inside the bundle's own content (cross-references, a
task's `uses:`, `supersededBy`) are not rewritten; the result lists the files
that still spell the old `<old>//` prefix so you can fix them by hand.

## akm clone

`akm clone` copies a single asset from any bundle into your working bundle (or
the bundle named by `--bundle`) for local editing. The copy is a separate asset
with its own ref; `akm show` with a short ref prefers the copy in your default
bundle, while the original stays where it was.

```sh
akm clone scripts/deploy.sh
akm clone skills/code-review --name my-code-review
akm clone scripts/deploy.sh --dest ./project/.claude
akm clone "npm:@scope/pkg//scripts/deploy.sh"   # From uninstalled package
```

Clone does not overwrite: use `--force` to replace an existing copy. Skills
(directories with `SKILL.md`) are copied recursively. All other types copy a
single file. `--dest` writes to a plain directory instead of a bundle; akm
indexes it only if you also add it as a bundle.

**Example: clone and customize a workflow**

```sh
akm clone workflows/ship-release
# Edit the copy in your working bundle; akm show workflows/ship-release now returns it
```

## akm sync

`akm sync` stages, commits, and optionally pushes your writable bundle. It is
the complement to `akm bundle add`: once you have made changes locally,
`sync` persists them to git.

```sh
akm sync                          # Primary bundle, auto timestamp message
akm sync -m "Add deploy skill"   # Custom commit message
akm sync my-skills -m "Update"   # Named writable git bundle
```

Push behavior depends on configuration: if the bundle is a git repo with a
remote and `writable: true`, sync also pushes. Otherwise it commits only.

Writes akm makes to a writable git bundle (for example
`akm remember --bundle my-skills`, `akm proposal accept`, or an improve run)
are committed as one commit at the end of the operation, and pushed when the
bundle has an upstream.

**Example: publish your own bundle**

```sh
# One-time setup (git-descriptor primary bundles only): mark it writable by
# setting bundles.<name>.writable: true in ~/.config/akm/config.json.
# A filesystem-type primary bundle is already writable by default.
akm sync -m "Add deployment skills"
# → stages, commits, and pushes to your configured remote
```

For the full workflow of turning a bundle into something others can install
(manifest conventions, versioning, and publishing to a registry), see the
[Bundle Author's Guide](author-bundles.md). For how a bundle's provider kind
maps to the code that indexes and fetches it, see
[Architecture](../architecture/architecture.md).

## akm registry

The registry is a discovery index: it lets you find and install bundles you
don't know about yet. The official registry ships pre-configured.

```sh
akm registry list                             # See configured registries
akm search "deploy" --from registry           # Search registry bundles by topic
akm registry add https://example.com/registry/index.json --name my-team
akm registry remove my-team
```

Once you find an interesting bundle in the registry, install it with `akm bundle add`:

```sh
akm search "kubernetes" --from registry
akm bundle add github:some-org/k8s-bundle
```

For the registry index schema, hosting a private registry, and how entries
get discovered, see [Registry](../reference/registry.md).

## See also

- [Discover & Load](discover-and-load.md) — querying the index after bundles are connected
- [Capture Knowledge](capture-knowledge.md) — writing your own assets
- [Use akm With Any Agent](use-with-any-agent.md) — using refs across bundles in prompts
- [Website Source Recipe](recipes/website-source.md) — walkthrough for adding a crawled website bundle
- [Website Sources](../reference/website-sources.md) — fetcher reference, X credentials, crawl options
- [Configuration](../reference/configuration.md) — bundle descriptor fields including `website` crawl knobs
- [CLI Reference](../reference/cli.md) — full flag documentation for `add`, `list`, `update`, `remove`, `clone`, `sync`, `registry`
- [Registry](../reference/registry.md) — registry index format and private registry setup
- [Bundle Author's Guide](author-bundles.md) — build and publish your own bundle
- [Architecture](../architecture/architecture.md) — how bundle providers are implemented
