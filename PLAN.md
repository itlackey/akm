# Plan: Introduce `akm kit` subcommand and make `akm add` a smart router

## Goal

Three explicit subcommand groups for the three core concepts, plus `akm add` as a smart thin wrapper:

```
akm add <anything>         # Smart router — detects type and delegates
akm kit add <ref>          # Install a kit (npm/github/git)
akm kit list               # List installed kits
akm kit remove <target>    # Remove an installed kit
akm kit update [target]    # Update installed kits
akm stash list             # List stash search paths
akm stash add <path>       # Add a local directory as stash source
akm stash remove <target>  # Remove a stash source
akm registry list          # List registries
akm registry add <url>     # Add a registry
akm registry remove <target>
akm registry search <query>
akm registry build-index
```

## Detection heuristics for `akm add`

`akm add` will inspect the input and route to the correct subcommand:

1. **Registry URL** → `akm registry add`: Input starts with `http://` or `https://` AND does NOT point to a known git host (github.com, gitlab.com, bitbucket.org). Registry URLs are index endpoints, not repo URLs.
2. **Local directory** → `akm stash add`: Input is a path-like ref (starts with `./`, `../`, `/`, or `file:`) and resolves to a local directory.
3. **Everything else** → `akm kit add`: npm refs (`@scope/pkg`, bare names), GitHub refs (`owner/repo`, `github:...`), git URLs (`git+https://...`, GitHub/GitLab/Bitbucket https URLs).

The existing `parseRegistryRef` in `registry-resolve.ts` already has the heuristics to distinguish local vs remote. We add a thin layer on top for registry URL detection.

## Top-level aliases

Keep `akm list`, `akm remove`, `akm update` as direct aliases for `akm kit list/remove/update` — they are unambiguous (only kits have these operations) and ergonomic. But the `kit` subgroup is the canonical form.

## Changes

### 1. `src/cli.ts` — Command definitions

- **New `kitCommand`**: A `defineCommand` with subCommands `add`, `list`, `remove`, `update`. Move the existing `addCommand` run logic into `kit add`. Keep `list`, `remove`, `update` implementations as-is.
- **Refactor `addCommand`**: Change to smart router that:
  1. Checks if input looks like a registry URL → delegates to registry add logic
  2. Checks if input is a local path → delegates to stash add logic
  3. Otherwise → delegates to kit add logic (existing `akmAdd`)
  4. Outputs a `routed` field indicating which subcommand was chosen
- **Top-level subCommands**: Add `kit: kitCommand`. Keep `list`, `remove`, `update` as aliases pointing to the same handlers.
- **Update stash command**: Keep as-is (already has `list`, `add`, `remove`).

### 2. `src/stash-add.ts` — Split kit install from stash add

- Rename file to reflect its dual nature, OR split into two exported functions:
  - `akmKitAdd(ref)` — handles remote kit installation only (current `addRegistryKit`)
  - `akmSmartAdd(ref)` — the smart router (current `akmAdd`)
- Export `addRegistryKit` so `kit add` can call it directly.

### 3. `src/cli.ts` — Registry add via `akm add`

- When `akm add https://example.com/registry/index.json` is called, detect it's a registry URL and call the same logic as `registry add`.
- Pass through `--name`, `--provider`, `--options` flags if present.

### 4. Update hints text

- Add `akm kit` commands to the hints output.
- Keep `akm add` documented as the smart shortcut.

### 5. Update docs

- `docs/cli.md`: Add `kit` subcommand section, update the "Three Ways to Add" table.
- `docs/concepts.md`: Reference `akm kit` commands.
- `docs/getting-started.md`: Use `akm kit add` in the "Install a Kit" section (or mention both forms).

### 6. Tests

- Add tests for the smart router detecting registry URLs, local paths, and kit refs.
- Existing e2e tests for `add`, `list`, `remove`, `update` continue to work (they're aliases).

## Implementation order

1. Export `addRegistryKit` from `stash-add.ts` and create `akmKitAdd` function
2. Create `kitCommand` in `cli.ts` with `add`, `list`, `remove`, `update` subcommands
3. Refactor top-level `addCommand` to be the smart router
4. Add `kit` to main subCommands
5. Update hints text
6. Update docs
7. Run `bun run check`
8. Commit and push
