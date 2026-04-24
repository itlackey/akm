## Docker build dependency contract

Docker builds run outside the Bun workspace — the monorepo's hoisted `node_modules` is not available. Each Dockerfile must resolve service dependencies explicitly. **This pattern is mandatory; do not deviate.** See [`docker-dependency-resolution.md`](docker-dependency-resolution.md) for full rationale.

### Admin (SvelteKit/Node build)

The admin Dockerfile uses **plain `npm install`** (not Bun) at a workspace root directory so `node_modules/` lands at a common ancestor of admin source paths. This gives standard Node module resolution a real directory tree with no symlinks. The build output is a self-contained SvelteKit adapter-node bundle — no runtime `node_modules` needed.

**Rules:**
* Never use Bun to install dependencies in the admin Docker build — Bun's symlink-based `node_modules` layout is fragile under Node/Vite resolution.
* `node_modules` must be at a common ancestor of all source directories that Vite resolves (admin source, assets, registry).
* `PATH` must include `node_modules/.bin` so build tool binaries (svelte-kit, vite) are available from subdirectories.

### Guardian + Channels (Bun runtime)

These Dockerfiles copy `packages/channels-sdk` source into `/app/node_modules/@openpalm/channels-sdk` and install sdk dependencies afterward:

```dockerfile
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production
```

This ensures sdk transitive dependencies are available at runtime. Since these services run on Bun (which created the install), there is no cross-tool resolution concern.

**Rules:**
* Every Dockerfile that copies `packages/channels-sdk` must run `bun install --production` inside the copied sdk directory.
* If `packages/channels-sdk/package.json` gains new dependencies, all service Dockerfiles automatically pick them up — no per-service changes needed.

---