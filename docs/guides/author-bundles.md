# Bundle Author's Guide

This guide walks through building a bundle, making it discoverable, and
sharing it so others can install it with `akm bundle add`. It assumes you
already know what a bundle is; see [Bundles](bundles.md) for the concept and
[Reference: Asset Types](../reference/asset-types.md) for the full catalog of
asset types, directory conventions, and per-type examples.

## Create a Bundle

A bundle is just a directory of assets. akm classifies each asset by **file
extension and content**, so directory names are hints, not requirements — a
`.sh` file is a script whether it lives in `scripts/`, `deploy/`, or the
bundle root, and nesting is fully supported.

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
`akm search` and never compete for ranking. They're read directly with
`akm show meta[:<name>]` (or `akm show <bundle>//meta[:<name>]` once
installed). See [Reference: Asset Types](../reference/asset-types.md) for the
`.meta/` layout and an example `index.md`.

## Write Metadata for Discovery

Metadata is not documentation for humans skimming your repo — it is the
signal an agent's search ranking runs on. Write descriptions that describe
*what the asset does and when to reach for it*, not just what it's named.

Prefer metadata that travels with the asset itself, so it can't drift out of
sync with the code:

- Markdown assets: a `description` in frontmatter is extracted automatically
  with high confidence.
- Scripts: header comments (`@param`, `@run`, `@setup`, `@cwd`) keep
  execution metadata next to the code it describes.
- Everything else: filenames and a nearby `package.json` provide fallback
  metadata when `akm index` runs.

If you still have a legacy `.stash.json` sidecar, migrate its fields into
inline metadata before publishing — see the
[v0.7 → v0.8 migration guide](../migration/v0.7-to-v0.8.md) for the full
field mapping and a worked example.

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

**Give scripts and workflows explicit safety and parameter metadata.** AKM
retrieves every supported capability type, but it only orchestrates execution
surfaces it can reason about — scripts run through `@run`/`@setup`/`@cwd`
declarations, workflows through their declared steps. Undocumented
parameters or missing execution hints don't make an asset safer to skip; they
make it a worse citizen of that boundary, forcing an agent (or a human) to
guess what a script does before running it. Document every parameter with
`@param`, declare the interpreter and working directory explicitly, and
describe destructive or irreversible steps in the body text.

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
in [Env Security](#env-security) below.

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
`--dest`, and the local copy wins in subsequent searches from that point
forward:

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
   `akm bundle add github:your-username/my-bundle#v1.0.0`. Installs are
   git-based — an unpinned add tracks the default branch, a `#ref` pins that
   tag/branch/commit — and the latest-release tarball is used only as a
   fallback when git access fails.

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
   copied into the install cache, and `.git` is always excluded. Remember to
   include `.meta` explicitly — dot-directories are otherwise easy to leave
   out of a published tarball (a GitHub tarball install includes `.meta/`
   automatically, without needing an allowlist).

3. `npm publish --access public`.
4. Others can now install it: `akm bundle add @your-scope/my-bundle`.

### Sharing on a Network Directory

For teams sharing assets without a registry, mount a bundle directly:

```sh
akm bundle add /mnt/shared/team-bundle
```

Assets appear in search results immediately, no further install step needed.
See [Bundles](bundles.md) for adding a mounted source to
`~/.config/akm/config.json` directly, and for write-safety behavior when a
mounted or git bundle is marked `writable`.

### Submitting to the Registry

The official [akm-registry](https://github.com/itlackey/akm-registry) lists
your bundle three ways: an npm package with `akm-stash` in `keywords`, the
`akm-stash` GitHub topic on your repo, or a PR against `manual-entries.json`
for a curated entry or override. Auto-discovered entries merge into
`index.json` on the registry's build cycle; curated entries are reviewed
before inclusion. For the registry's entry schema and how auto-discovered
and curated entries are reconciled, see
[Reference: Registry](../reference/registry.md).

CLI-based submission (`akm` driving the PR) is planned for a future release.

## Write-Safety Expectations

Publishing a bundle does not make it writable by default. `akm bundle add`
installs git, npm, and website bundles read-only unless the source is
explicitly marked `writable` (filesystem sources are the exception — local
directories are writable by default, opt out with `writable: false`), and
only the primary bundle or a source resolved as writable accepts changes back (via `akm sync`, `akm clone --dest`, or
`akm remember --bundle`). If you're publishing a bundle you expect other
teams to write back into — not just install and read — say so in your
`README.md` and document the `writable: true` configuration your users need.
See [`akm sync`](bundles.md#akm-sync) for exactly what gets committed and
when a push happens.

## Env Security

> The `vault` asset type was removed in 0.9.0; `env` replaces it. See the
> [0.8 → 0.9 migration guide](../migration/v0.8-to-v0.9.md).

If your bundle includes env files under `env/`, be aware of how `akm` handles
them during install.

**Dangerous key detection.** `akm bundle add` and `akm lint` scan env files for
environment variable names that can be used to hijack process execution when
the file is loaded via `akm env run`. The flagged names include `LD_PRELOAD`,
`PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, and 37 others (41 literal
keys total), plus two pattern-based families (`BASH_FUNC_*`, Shellshock-class
injection; `GIT_CONFIG_*`, git config override injection). When these keys
are found, `akm bundle add` pauses in interactive mode and asks the user to confirm
before continuing. In non-interactive (CI) mode the install fails unless the
user passes `--allow-dangerous-env-keys`. `akm env run` applies the same scan at
run time: a third-party-sourced bundle is refused unless that reviewed run
explicitly passes `--allow-dangerous-env-keys`; a first-party bundle warns and
proceeds.

This is not a ban — it is a speed bump. If your bundle legitimately needs one
of these keys (for example, a `PATH` override for a hermetic toolchain), do
the following before publishing:

1. Document the reason clearly in your `README.md`. Explain which key is set,
   why it is needed, and what the value does.
2. Run `akm lint` against your bundle locally to see the `dangerous-env-key`
   findings before your users do (suppress a specific key with a
   `# akm-lint-ok: dangerous-env-key` comment on the preceding line):

   ```sh
   akm lint
   ```

3. Consider whether the value can be set by the user after install rather than
   shipped in the env file. Env files that ship without values — just key names
   and comments — do not trigger the audit.

**Key names are metadata, not secrets.** Env key names appear in `akm env list`
and search results by design. Only values are protected. The `--sensitive` flag
on `akm env create` excludes a file from both `env list` output and the search
index; its key names then surface only when the file is shown directly by ref.

## Bundle Structure Tips

- **Keep it focused.** A bundle with 5 great scripts is more useful than one
  with 50 mediocre ones.

- **Write good descriptions.** The `description` field (preferably in
  frontmatter, otherwise in script comments or `package.json`) is the primary
  signal for search ranking.

- **Use frontmatter in markdown assets.** A `description` in frontmatter is
  extracted automatically with high confidence (0.9), making your commands,
  agents, and knowledge documents more discoverable.

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
