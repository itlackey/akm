# Bundles

akm works toward two outcomes: bring the agent assets you already have into
one library, and install (or share) reusable capability bundles with other
people. Both go through the same primitive — a **bundle** — which can be a
local directory, a git repo, an npm package, or a crawled website.
**Registries** are discovery indexes that let you find bundles you haven't
heard of yet. Together they give you a unified, searchable library that pulls
from anywhere and grows over time.

## Bring what you already have into one library

If you already have skills, commands, or agent configs scattered across
different tools, point akm at each of them. Nothing moves — akm indexes assets
in place — and every asset becomes retrievable through the same search and
curate commands regardless of which agent originally created it.

```sh
akm bundle add ~/.claude               # Claude Code's project/user assets
akm bundle add ~/.config/opencode      # OpenCode's config directory
akm index                              # Bring the search index up to date
akm curate "plan a release"            # Pull the best matches from every bundle you added
```

This is the "one library for every agent" idea in practice: assets authored
for one tool become discoverable — and usable — from any other.

## akm bundle add

`akm bundle add` connects a new bundle. The source kind is inferred from the
input: known git hosts and URLs ending in `.git` are git bundles, while other
HTTP(S) URLs are website bundles.

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
| `git` | `github:`, known git-host URL, or URL ending in `.git` | Cloned into `~/.cache/akm/registry/`, read-only by default |
| `npm` | `@scope/pkg` | Installed into cache, read-only |
| `website` | Other HTTP/HTTPS URL | Crawled, converted to markdown, refreshed every 12 hours |

`akm bundle add` materializes and indexes Git install refs before it reports
success. A declarative `--provider git` add does the same, including writable
checkouts. Other declarative provider entries are materialized by
`akm bundle update`.

**Bundle naming.** `--name` sets the bundle's key — akm's config, index, and
every persisted ref hang off it. It is a contract, not a hint: it must be a
legal bundle slug (no `:` `.` `#` `/` or whitespace), and it must not already
be taken by a different bundle, or the add fails before writing anything.
Re-adding a source that is already installed under a different `--name` than
it already carries also fails, naming the existing key — use
[`akm bundle rename`](#akm-bundle-rename) instead of trying to relabel it
through `add`. Every `akm bundle add` result carries `bundleId` (its
resolved key), so scripting against the JSON output never has to guess it
back out of `sourceAdded`/`installed`. Without `--name`, akm derives one
(the directory name, the package/repo name, or the hostname), falling back to
a `-<hash>` suffix only on a collision — that forgiving fallback applies
solely to a derived name, never to an explicit `--name`.

Git credentials must be symbolic references: `$VAR`, `${VAR}`, or
`secret://name`. AKM resolves the reference only at the Git subprocess boundary
and sends it as an HTTPS bearer header; it does not put the token in the remote
URL or `config.json`.

**Website bundles.** A `website` URL is offered to a set of specialized
fetchers (YouTube, Bluesky, X, RSS/Atom feeds) before falling back to a
general crawl, and crawl behavior (page/depth limits, timeouts, robots.txt)
is configurable. See the
[website source recipe](recipes/website-source.md) for a walkthrough and
[Website Sources](../reference/website-sources.md) for the full fetcher
reference, X credential setup, and crawl-option details. Low-level knobs like
`crawlTimeoutMs` and `respectRobots` live in the bundle's `website`
descriptor — see [Configuration](../reference/configuration.md).

**Example: add a team bundle from GitHub**

```sh
akm bundle add github:my-org/team-bundle --name team
akm index
akm search "deploy" --type script
```

## akm bundle list

`akm bundle list` shows all configured bundles — local directories, managed
packages, and remote providers — so you know what is in your library.

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

`akm bundle update` refreshes git, npm, and website bundles. Each candidate is
staged outside its active root, audited for dangerous environment keys, and
only then published and indexed. `akm bundle remove` disconnects a bundle and
re-indexes without it.

Bundle refresh is deliberately explicit: Git bundles do not poll upstream on
their own. Consumers that want automatic refresh should schedule
`akm bundle update <name>` or `akm bundle update --all`. Scheduled invocations
should pass `--skip-if-locked` so concurrent index or improve activity becomes
a successful skip instead of exit 75.

```sh
# Update
akm bundle update @scope/bundle          # One managed bundle
akm bundle update --all                 # All managed bundles
akm bundle update --all --force         # Force fresh download even if version unchanged
akm bundle update --all --skip-if-locked # Scheduled refresh: exit 0 on DB contention
akm bundle update @scope/bundle --allow-dangerous-env-keys  # Approve reviewed dangerous env keys

# Remove
akm bundle remove @scope/bundle          # By npm id
akm bundle remove github:owner/repo     # By git ref
akm bundle remove ~/.claude/skills      # By path
akm bundle remove my-provider           # By name
```

Dangerous keys prompt in a terminal (default: No) and block non-interactive
updates unless `--allow-dangerous-env-keys` is explicit. `--yes` only approves deletion
of an obsolete moved install directory; it never approves security findings.
For `--all`, blocked and failed bundles are reported separately and later
bundles continue. A rejected or failed bundle keeps its prior bytes, lock/config
state, and search-index generation.

Private bundles that intentionally version every file under `env/` and
`secrets/` can place this documented marker anywhere in their root
`.gitignore`:

```gitignore
# akm: intentionally track env and secrets
```

The stash scaffold then leaves the ignore file unchanged. Use this only for a
private remote whose exposure policy you have reviewed.

During publication AKM holds a SQLite writer transaction across the index and
the update-owned state work. Existing readers keep seeing the prior generation,
but other writers may wait for a full index pass. This provides process-fault
rollback for handled errors, not atomic durability across the filesystem and
two WAL database files during `SIGKILL`, power loss, or storage failure. After
such a failure, stop writers, run `akm health`, rerun the targeted update if its
checkout/lock is not the intended revision, and run
`akm index --full`. The `index-state-generation` advisory detects mismatched
durable usage links; it cannot detect every theoretical cross-file split.

**Example: keep bundles fresh**

```sh
akm bundle update --all && akm index
```

## akm bundle rename

`akm bundle rename <old> <new>` is the one command allowed to change a
configured bundle's key. A bundle id is a mass identity prefix: every ref this
tool minted (`entries.item_ref`, `proposals.ref`, a pending proposal's write
target, a workflow's `task_history.target_ref`, `scheduler.enabled[].ref`)
carries it, so hand-editing the `bundles` key in `config.json` strands all of
it — the rest of akm keeps reading the old prefix out of the index and state
databases while config names the new one.

```sh
akm bundle rename old-name new-name --dry-run   # See the plan first
akm bundle rename old-name new-name
```

`<new>` must be a legal, unused bundle slug — the same `--name` contract
`akm bundle add` enforces. Rewritten: the config key,
`defaultBundle`/`defaultWriteTarget` when they name the old id, every
scheduler grant's ref, the lockfile entry, every indexed entry's `bundle_id`,
the metadata-enrichment LLM cache keyed by the same `item_ref`, and this
tool's own state rows that name the old bundle. Reported, never rewritten:
refs inside the bundle's own content (cross-references, a task's `uses:`,
`supersededBy`) — the command lists the files that still spell the old
`<old>//` prefix so you can fix them by hand. A real run also re-syncs native
scheduler bindings under the new name on its own, so scheduled tasks pick it
up immediately — but the result's `taskSync.ok` is `false` when a binding
fails to re-sync too, not only when the sync call itself fails, so a partial
re-sync is never reported as clean; `--dry-run` lists the installed native
rows that still name the old bundle, so you can see what that sync will
replace.

## akm clone

`akm clone` copies a single asset from any bundle into your writable bundle
(or a custom destination) for local editing. After cloning, your local copy
wins in subsequent searches automatically.

```sh
akm clone scripts/deploy.sh
akm clone skills/code-review --name my-code-review
akm clone scripts/deploy.sh --dest ./project/.claude
akm clone "npm:@scope/pkg//scripts/deploy.sh"   # From uninstalled package
```

Clone is non-destructive: use `--force` to overwrite an existing local copy.
Skills (directories with `SKILL.md`) are copied recursively. All other types
copy a single file.

**Example: clone and customize a workflow**

```sh
akm clone workflows/ship-release --dest ./project/.claude
# Edit ./project/.claude/workflows/ship-release.md
# The local copy wins in searches from this directory forward
```

## akm sync

`akm sync` stages, commits, and optionally pushes your writable bundle. It is
the complement to `akm bundle add`: once you have made changes locally,
`sync` persists them to git. (There is no `akm save` command — use
`akm sync`.)

```sh
akm sync                          # Primary bundle, auto timestamp message
akm sync -m "Add deploy skill"   # Custom commit message
akm sync my-skills -m "Update"   # Named writable git bundle
```

Push behavior depends on configuration: if the bundle is a git repo with a
remote and `writable: true`, sync also pushes. Otherwise it commits only.

Writes that land on a writable git bundle via an explicit destination flag
(e.g. `akm remember --bundle my-skills`, proposal accept/revert, consolidate)
are committed automatically in a single batch at the end of the operation —
one complete commit (staging `.akm/` + assets together), pushed under the
same `writable + remote` gate as `akm sync`. `options.pushOnCommit` is
rejected at config load; remove it and rely on `writable: true` + push
instead.

**Example: publish your own bundle**

```sh
# One-time setup (git-descriptor primary bundles only): mark it writable by
# setting bundles.<name>.writable: true in ~/.config/akm/config.json.
# A filesystem-type primary bundle is already writable by default.
akm sync -m "Add deployment skills"
# → stages, commits, and pushes to your configured remote
```

For the full workflow of turning a bundle into something others can install —
manifest conventions, versioning, and publishing to a registry — see the
[Bundle Author's Guide](author-bundles.md). For how a bundle's provider kind
maps to the code that indexes and fetches it, see
[Architecture](../architecture/architecture.md).

## Install and share reusable capability bundles

The other half of the bundle story is discovery: finding bundles other people
have published, and publishing your own so others can install it. `akm bundle
add` (above) is how you install one once you know where it lives; the
registry (below) is how you find it in the first place.

## akm registry

The registry is a discovery index — it lets you find and install bundles you
don't know about yet. The official registry ships pre-configured.

```sh
akm registry list                             # See configured registries
akm search "deploy" --from registry           # Search registry bundles by topic
akm search "code review" --from registry --assets  # Include asset-level hits
akm registry add https://example.com/registry/index.json --name my-team
akm registry remove my-team
```

Once you find an interesting bundle in the registry, install it with `akm bundle add`:

```sh
akm search "kubernetes" --from registry
akm bundle add github:some-org/k8s-bundle
akm index
```

For the registry index schema, hosting a private registry, and how entries
get discovered, see [Registry](../reference/registry.md).

## See also

- [Discover & Load](discover-and-load.md) — querying the index after bundles are connected
- [Knowledge Management](knowledge-management.md) — writing your own assets
- [Use akm With Any Agent](use-with-any-agent.md) — using refs across bundles in prompts
- [Website Source Recipe](recipes/website-source.md) — walkthrough for adding a crawled website bundle
- [Website Sources](../reference/website-sources.md) — fetcher reference, X credentials, crawl options
- [Configuration](../reference/configuration.md) — bundle descriptor fields including `website` crawl knobs
- [CLI Reference](../reference/cli.md) — full flag documentation for `add`, `list`, `update`, `remove`, `clone`, `sync`, `registry`
- [Registry](../reference/registry.md) — registry index format and private registry setup
- [Bundle Author's Guide](author-bundles.md) — build and publish your own bundle
- [Architecture](../architecture/architecture.md) — how bundle providers are implemented
