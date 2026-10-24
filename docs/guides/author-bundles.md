# Bundle Author's Guide

This guide walks through building a bundle, making it discoverable, and
sharing it so others can install it with `akm bundle add`. It assumes you
already know what a bundle is; see [Bundles](bundles.md) for the concept and
[Reference: Asset Types](../reference/asset-types.md) for the full catalog of
asset types, directory conventions, and per-type examples.

## Create a Bundle

A bundle is just a directory of assets. akm classifies scripts, knowledge,
commands, agents and workflows by **file extension and content**, so directory
names are hints for those, not requirements: a `.sh` file is a script whether
it lives in `scripts/`, `deploy/`, or the bundle root, and nesting is fully
supported. Env files, secrets, memories and the other placement-based types
are found only under their own directory.

```sh
mkdir my-bundle && cd my-bundle
mkdir scripts skills commands agents knowledge
# add your assets, then verify locally
akm bundle add .
akm index
akm search "deploy"
```

For the preferred directory layout, the full set of supported asset types
(scripts, skills, commands, agents, knowledge, memories, workflows, tasks,
env files, and more), and worked examples of each, see
[Reference: Asset Types](../reference/asset-types.md).

Add a `.meta/` directory at the bundle root to orient readers to the bundle
*as a whole* — what it's for, where to start, conventions to follow. `.meta/`
is a dot-directory, so the indexer skips it: these docs never appear in
`akm search`. They're read directly with `akm show meta` (the bundle's
`.meta/index.md`) or `akm show meta:<name>`, and `akm show <bundle>//meta` or
`akm show <bundle>//meta:<name>` for an installed bundle. This `meta:` form is
the one exception to the `[bundle//]conceptId` ref grammar. See
[Reference: Asset Types](../reference/asset-types.md) for the `.meta/` layout
and an example `index.md`.

## Write Metadata for Discovery

Metadata is not documentation for humans skimming your repo: search matches
an asset's name, description, tags, hints and content, and an agent chooses
from the lean result list. Write descriptions that describe *what the asset
does and when to reach for it*, not just what it's named.

Prefer metadata that travels with the asset itself, so it can't drift out of
sync with the code:

- Markdown assets: a `description` in frontmatter is used as the asset's
  description.
- Scripts: header comments (`@param`, `@run`, `@setup`, `@cwd`) keep
  execution metadata next to the code it describes.
- Everything else: filenames and a nearby `package.json` provide fallback
  metadata when `akm index` runs.

**Keep `show` payloads focused.** `akm show` returns the whole asset body by
default (the whole document for a knowledge asset, the whole `SKILL.md` for a
skill). An agent that calls `show` pays for every token you put in that
payload. Split long reference material into headed sections so agents can
request one slug at a time (`akm show knowledge/guide#rate-limits`) instead of
the entire document, and keep skills and commands scoped to one task rather
than a bundle of unrelated instructions.

**Separate reusable instructions from project-specific memory.** Skills,
commands, and agents should describe how to do something in a way that holds
up across projects. Anything that's true only for *this* project or *this*
run — a decision made in a retro, a fact about the current deployment, a
lesson learned from a failure — belongs in `memories/`, `facts/`, or
`lessons/`, not baked into a skill's instructions. Mixing the two makes the
reusable asset harder to reuse elsewhere and makes the project-specific
context harder to find and prune later.

**Document scripts and workflows.** `akm show` turns a script's
`@run`/`@setup`/`@cwd` headers into the `run` command an agent executes, and a
workflow's declared steps into what it runs. Document every parameter with
`@param`, declare the interpreter and working directory explicitly, and
describe destructive or irreversible steps in the body text, so an agent does
not have to guess what a script does before running it.

## Test Before You Publish

Before sharing, install your bundle locally and confirm the assets are both
present and *findable*:

```sh
# Install from the local directory
akm bundle add ./my-bundle
akm bundle list

# Exact-name lookups
akm show scripts/deploy.sh

# Realistic queries -- not just the asset's own name
akm search "ship a release"
akm curate "deploy the app to staging"
```

Testing only exact-name search hides ranking problems your users will hit
immediately: someone looking for "deploy" won't necessarily type `deploy.sh`.
Search with the phrasing you expect users (and agents) to actually use, and
with `akm curate` for task-shaped queries. If results are poor or your asset
doesn't surface, improve the description, tags, and search hints rather than
renaming the file to match the query.

Run `akm lint` before you publish. It catches structural problems (missing
`name`/`type` on commands and agents, broken refs, malformed workflow
structure, invalid task YAML) as well as the dangerous-env-key scan described
in [Env files](#env-files) below.

```sh
akm lint
```

## Version Bundles and Document Compatibility

Use npm versions or GitHub releases so users can pin to a known-good state
instead of tracking your default branch:

```sh
akm bundle add npm:pkg@1.2.3
akm bundle add github:owner/repo#v1.2.3
```

Note in your `README.md` which `akm-cli` version(s) your bundle targets,
especially if you rely on a feature that shipped recently (a new asset type,
a frontmatter field, a lint rule). Breaking changes to your own bundle's
layout deserve the same treatment you'd want from akm itself: a note in your
changelog and, if the change is large, a short migration note for anyone
pinned to the old layout.

## Design for Local Customization

Users are expected to fork individual assets out of your bundle rather than
edit your source tree directly. `akm clone` copies one asset (or, for a
skill, its whole directory) into the user's writable bundle or a custom
`--dest`. The copy is a separate asset with its own ref, and `akm show` with a
short ref prefers the copy in the user's default bundle:

```sh
akm clone scripts/deploy.sh
akm clone scripts/deploy.sh --dest ./project/.claude
```

Design assets so a clone-and-edit workflow actually works: keep parameters
and setup steps explicit rather than hard-coded, avoid assumptions about
paths outside the bundle, and prefer one asset per concern so a user can
clone the one thing they need to change without dragging in unrelated
behavior. See [`akm clone`](bundles.md#akm-clone) for the full command
reference.

## Publish Your Bundle

Detailed, provider-by-provider behavior for `akm bundle add` (git, npm,
filesystem, website) lives in [Bundles](bundles.md); the summaries below
cover only what changes when you're the one publishing.

### Sharing on GitHub

1. Push your bundle to a GitHub repository.
2. Add the `akm-stash` topic to your repo so it appears in registry search
   (`gh repo edit --add-topic akm-stash`, or from repository settings under
   "Topics").
3. Others can now install it: `akm bundle add github:your-username/my-bundle`.
4. To pin a version, tag a release and install with a `#ref`:
   `akm bundle add github:your-username/my-bundle#v1.0.0`. An unpinned add
   tracks the default branch; a `#ref` pins that tag, branch or commit.

### Sharing on npm

1. Add a `package.json` with `"akm-stash"` in `keywords`.
2. If your repo contains files that shouldn't ship (source, tests, CI
   config), use `akm.include` to declare which paths to publish:

   ```json
   {
     "name": "@your-scope/my-bundle",
     "version": "1.0.0",
     "keywords": ["akm-stash"],
     "akm": { "include": ["scripts", "skills", "knowledge", ".meta"] }
   }
   ```

   Paths are relative to `package.json`; only listed directories/files are
   copied into the install cache, and `.git` is always excluded. Include
   `.meta` explicitly, since dot-directories are easy to leave out of a
   published tarball.

3. `npm publish --access public`.
4. Others can now install it: `akm bundle add @your-scope/my-bundle`.

### Sharing on a Network Directory

For teams sharing assets without a registry, mount a bundle directly:

```sh
akm bundle add /mnt/shared/team-bundle
```

`akm bundle add` indexes the bundle, so its assets appear in search results
straight away. A local path is writable by default; pass `writable: false` in
config to make it read-only.

### Submitting to the Registry

The official [akm-registry](https://github.com/itlackey/akm-registry) lists
your bundle three ways: an npm package with `akm-stash` in `keywords`, the
`akm-stash` GitHub topic on your repo, or a PR against `manual-entries.json`
for a curated entry or override. Auto-discovered entries merge into
`index.json` on the registry's build cycle; curated entries are reviewed
before inclusion. For the registry's entry schema and how auto-discovered
and curated entries are reconciled, see
[Reference: Registry](../reference/registry.md).

## Writable bundles

Publishing a bundle does not make it writable. `akm bundle add` installs git,
npm, and website bundles read-only unless a git bundle is explicitly marked
`writable` (`writable: true` on npm and website bundles is rejected at config
load). Local directories are writable by default; opt out with
`writable: false`. Only a writable bundle accepts writes such as
`akm remember --bundle`, `akm proposal accept` and `akm sync`. If you expect
other teams to write back into your bundle, say so in your `README.md` and
document the `writable: true` configuration your users need. See
[`akm sync`](bundles.md#akm-sync) for exactly what gets committed and when a
push happens.

## Env files

If your bundle includes env files under `env/`, `akm bundle add`, `akm bundle
update` and `akm lint` scan them for variable names that change how a process
starts when the file is loaded with `akm env run`: 41 names, including
`LD_PRELOAD`, `PATH`, `DYLD_INSERT_LIBRARIES` and `NODE_OPTIONS`, plus the
`BASH_FUNC_*` and `GIT_CONFIG_*` prefixes. A flagged key makes `akm bundle add`
ask for confirmation in a terminal and stop in a non-interactive run unless
`--allow-dangerous-env-keys` is passed; `akm lint` reports it as
`dangerous-env-key`. `akm env run` makes the same check when it loads a file
from an installed bundle (it stops unless you pass that flag) and only warns for
a file in your own bundle. If your bundle needs one of these keys, say why in your
`README.md`, or leave its value out of the shipped file. Suppress a single key
with a `# akm-lint-ok: dangerous-env-key` comment on the preceding line.

Key names are listed by `akm env list` and appear in search results. The
`--sensitive` flag on `akm env create` leaves a file out of `env list` and the
search index; its key names then appear only when the file is shown directly
by ref.

## Bundle Structure Tips

- **Keep it focused.** A bundle with 5 great scripts is more useful than one
  with 50 mediocre ones.

- **Write good descriptions.** The `description` field (preferably in
  frontmatter, otherwise in script comments or `package.json`) is what an
  agent reads in search and curate results when it decides what to load.

- **Use frontmatter in markdown assets.** A `description` in frontmatter is
  picked up automatically, making your commands, agents, and knowledge
  documents easier to choose between.

- **Use structured header comments for scripts.** `.sh`, `.ts`, `.py`, etc. get
  strong results from good filenames plus leading comments and tags like
  `@param`, `@run`, `@setup`, and `@cwd`.

- **Test the search experience.** After installing your bundle, search for it
  using the terms you expect users to try, not just the asset's own name. If
  results are poor, improve the descriptions, tags, and search hints.

- **Document usage in the asset itself.** For skills, put the instructions in
  `SKILL.md`. For commands, put the workflow in the markdown body. The agent
  reads these directly.

- **Version your bundle.** Use npm versions or GitHub releases so users can pin
  to a known-good state with `akm bundle add npm:pkg@1.2.3` or
  `akm bundle add github:owner/repo#v1.2.3`.
