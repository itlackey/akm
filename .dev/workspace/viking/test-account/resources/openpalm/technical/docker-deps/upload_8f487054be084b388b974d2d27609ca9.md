# Docker Dependency Resolution

## Problem

The monorepo uses Bun workspaces locally, where `bun install` at the repo root
hoists all dependencies so module resolution works seamlessly. Docker builds
don't have this luxury — each service builds in isolation, and the workspace
structure isn't available.

The admin service is built with Node + Vite, while guardian/channel services run
on Bun and copy workspace source into image-local `node_modules` paths. The two
toolchains require explicit, predictable dependency resolution in Docker.

## Solution: Admin (SvelteKit/Node build)

Install admin's dependencies at the **workspace root** (`/workspace/`) so
`node_modules` sits at a common ancestor of admin build sources:

```
/workspace/
├── node_modules/        ← npm install puts deps here (real dirs, no symlinks)
├── packages/admin/          ← SvelteKit source + vite.config.ts
├── assets/
└── registry/
```

Key details:
- `npm install` (not Bun) creates standard flat `node_modules/` — real
  directories, no symlinks
- `ENV PATH="/workspace/node_modules/.bin:$PATH"` makes build tool binaries
  (svelte-kit, vite) available to `npm run build` from the `packages/admin/` subdirectory
- No Bun binary, no workspace protocol, no lockfile coupling
- The output is a self-contained SvelteKit adapter-node bundle — no runtime
  `node_modules` needed

## Solution: Guardian + Channels (Bun runtime)

These services copy `packages/channels-sdk` source directly into
`/app/node_modules/@openpalm/channels-sdk` and run on Bun. To resolve sdk
transitive dependencies, each Dockerfile runs:

```dockerfile
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production
```

This installs sdk declared dependencies into
`/app/node_modules/@openpalm/channels-sdk/node_modules/`. Since these services run on
Bun (which created the install), there's no cross-tool resolution concern.

## Why not Bun workspace install in Docker?

Bun's `node_modules` layout uses symlinks to a `.bun/` cache directory. While
this works with Bun's own resolver, it couples the Docker build to Bun's
internal implementation detail. The admin build runs on Node.js/Vite, so
depending on Bun's symlink structure for Node module resolution is fragile.

## Files changed

| File | What | Why |
|------|------|-----|
| `core/admin/Dockerfile` | npm install at workspace root | Common ancestor for module resolution |
| `core/guardian/Dockerfile` | Install channels-sdk deps after copy | Ensure sdk transitive deps resolve |
| `core/channel/Dockerfile` | Install channels-sdk deps after copy | Robustness for future sdk dependencies |
