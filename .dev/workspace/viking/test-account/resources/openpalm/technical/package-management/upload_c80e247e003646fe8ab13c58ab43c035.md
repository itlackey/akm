# Package Management

## Single Lock File Policy

This repo uses **one lock file**: the root `bun.lock`. All other lock files (`package-lock.json`, nested `bun.lock` files) are either gitignored or deleted.

### Why one lock file

- Bun workspaces resolve all workspace packages from the root `bun.lock`. Nested lock files conflict with this and cause drift.
- `package-lock.json` was a leftover from the v0.5.0 migration. No CI workflow or Dockerfile ever referenced it.
- Multiple lock files cause CI failures (`--frozen-lockfile`) when they drift, confusing diffs, and cognitive overhead.

### Rules

1. **`bun install` at repo root** is the only install command that modifies the lock file.
2. **`--frozen-lockfile`** is used in CI to catch forgotten installs after dependency changes.
3. **`.npmrc`** at repo root contains `package-lock=false` to prevent npm from generating `package-lock.json` when `npm install` runs inside `packages/admin/`.
4. **`package-lock.json`** is in `.gitignore` as a safety net.

### Adding or updating a dependency

```bash
# From repo root:
bun add <package>                        # root dependency
bun add <package> --cwd packages/foo     # workspace package dependency

# Then verify:
bun install --frozen-lockfile            # should pass — lock file is already updated
```

## Cross-Package References

All `@openpalm/*` cross-references in `dependencies`, `devDependencies`, and `peerDependencies` use **real semver ranges** (e.g. `"^0.7.0-rc1"`), not `workspace:*`.

### Why real ranges, not `workspace:*`

- Bun workspaces resolve dependencies by **package name**. When a dependency matches a workspace package, Bun uses the local copy regardless of the version range. A real range like `"^0.7.0-rc1"` works identically to `"workspace:*"` during local development.
- `workspace:*` is a Bun/pnpm-specific protocol. npm cannot resolve it, so published packages would ship the literal string `workspace:*` — breaking consumers.
- Docker builds that `bun install --production` after copying SDK source also resolve by name, so real ranges work there too.

### Keeping ranges in sync

Platform packages (root, `packages/admin`, `core/guardian`, `packages/cli`) share a coordinated version bumped by `scripts/bump-platform.sh`. npm packages (`packages/channels-sdk`, `packages/channel-*`, `packages/assistant-tools`) are versioned independently via per-package publish workflows. Cross-references between the two groups use real semver ranges and are updated manually when a dependency's API changes.

### Why Docker builds don't use lock files

Docker builds install dependencies without `--frozen-lockfile`:

- **Admin** (`core/admin/Dockerfile`) uses `npm install` because the SvelteKit build requires Node.js and npm — not Bun. The `.npmrc` prevents npm from creating a lock file inside the image.
- **Guardian** and **channel** Dockerfiles use `bun install --production` after copying only the source files they need. They don't mount the root lock file because they only install a small subset of workspace dependencies.

This is intentional. The lock file guards the development workflow (ensuring reproducible local installs and CI checks). Docker builds produce immutable images and are tested by CI's `docker compose config` validation.
