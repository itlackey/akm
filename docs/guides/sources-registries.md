# Sources & Registries

Every asset in akm comes from a **source** — a local directory, git repo, npm
package, or crawled website. **Registries** are discovery indexes that let you
find sources you haven't heard of yet. Together they give you a unified,
searchable library that can pull from anywhere and grow over time.

## akm add

`akm add` connects a new source. The source kind is inferred from the input:
no flags required for the common cases.

```sh
akm add ~/.claude/skills                          # Local directory (filesystem)
akm add github:owner/team-stash                  # GitHub repo (git)
akm add @scope/stash                              # npm package
akm add npm:@scope/stash@latest                  # npm with version pin
akm add github:owner/repo#v1.2.3                 # GitHub at a specific tag
akm add https://docs.example.com --name docs     # Crawled website (website)
akm add https://docs.example.com --max-pages 200 --max-depth 5

# Add the official onboarding stash:
akm add github:itlackey/akm-stash

# Mark a git stash as writable (enables akm sync to push):
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
```

| Source kind | Input shape | Behavior |
| --- | --- | --- |
| `filesystem` | local path | Indexed in place, writable by default |
| `git` | `github:`, git URL | Cloned into `~/.cache/akm/registry/`, read-only by default |
| `npm` | `@scope/pkg` | Installed into cache, read-only |
| `website` | HTTP/HTTPS URL (non-git host) | Crawled, converted to markdown, refreshed every 12 hours |

After `akm add`, run `akm index` to bring the search index up to date.

**Example: add a team stash from GitHub**

```sh
akm add github:my-org/team-stash --name team
akm index
akm search "deploy" --type script
```

## akm list

`akm list` shows all configured sources — local directories, managed packages,
and remote providers — so you know what is in your library.

```sh
akm list                        # All sources
akm list --kind local           # Only local directories
akm list --kind managed         # Only git / npm packages
akm list --kind remote          # Only remote providers
akm list --kind local,managed   # Multiple kinds
```

## akm update / akm remove

`akm update` pulls the latest version of a managed (git or npm) source.
`akm remove` disconnects a source and re-indexes without it.

```sh
# Update
akm update @scope/stash          # One managed source
akm update --all                 # All managed sources
akm update --all --force         # Force fresh download even if version unchanged

# Remove
akm remove @scope/stash          # By npm id
akm remove github:owner/repo     # By git ref
akm remove ~/.claude/skills      # By path
akm remove my-provider           # By name
```

**Example: keep sources fresh**

```sh
akm update --all && akm index
```

## akm clone

`akm clone` copies a single asset from any source into your writable stash (or
a custom destination) for local editing. After cloning, your local copy wins in
subsequent searches automatically.

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

`akm sync` stages, commits, and optionally pushes your writable stash. It is
the complement to `akm add`: once you have made changes locally, `sync` persists
them to git. (There is no `akm save` command — use `akm sync`.)

```sh
akm sync                          # Primary stash, auto timestamp message
akm sync -m "Add deploy skill"   # Custom commit message
akm sync my-skills -m "Update"   # Named writable git source
```

Push behavior depends on configuration: if the stash is a git repo with a
remote and `writable: true`, sync also pushes. Otherwise it commits only.

Writes that land on a writable git source via `--target` (e.g.
`akm remember --target my-skills`, proposal accept/revert, consolidate) are
committed automatically in a single batch at the end of the operation — one
complete commit (staging `.akm/` + assets together), pushed under the same
`writable + remote` gate as `akm sync`. The per-asset `options.pushOnCommit`
knob is deprecated; rely on `writable: true` + push instead.

**Example: publish your own stash**

```sh
# One-time setup: make the primary stash push on sync
# Set `"writable": true` in ~/.config/akm/config.json
akm sync -m "Add deployment skills"
# → stages, commits, and pushes to your configured remote
```

## akm registry

The registry is a discovery index — it lets you find and install stashes you
don't know about yet. The official registry ships pre-configured.

```sh
akm registry list                         # See configured registries
akm registry search "deploy"              # Search registry stashes by topic
akm registry search "code review" --assets  # Include asset-level hits
akm registry add https://example.com/registry/index.json --name my-team
akm registry remove my-team
```

Once you find an interesting stash in the registry, install it with `akm add`:

```sh
akm registry search "kubernetes"
akm add github:some-org/k8s-stash
akm index
```

## See also

- [Search & Discovery](search-discovery.md) — querying the index after sources are connected
- [Knowledge Management](knowledge-management.md) — writing your own assets
- [Agent Integration](agent-integration.md) — using refs across sources in prompts
- [CLI Reference](../reference/cli.md) — full flag documentation for `add`, `list`, `update`, `remove`, `clone`, `sync`, `registry`
- [Registry](../reference/registry.md) — registry index format and private registry setup
- [Stash Maker's Guide](../guides/stash-makers.md) — build and publish your own stash
