## Key Files

| Path | Purpose |
|---|---|
| `docs/technical/core-principles.md` | **Authoritative architectural rules** |
| `docs/technical/code-quality-principles.md` | Engineering invariants and quality contracts |
| `docs/technical/docker-dependency-resolution.md` | **Docker build dependency patterns (must follow)** |
| `docs/technical/package-management.md` | Single lock file policy and dependency workflow |
| `docs/technical/bunjs-rules.md` | Bun built-in API rules |
| `docs/technical/sveltekit-rules.md` | SvelteKit-specific implementation rules |
| `packages/admin/src/lib/server/control-plane.ts` | Barrel re-export of all server modules |
| `packages/admin/src/lib/server/helpers.ts` | Shared request/response utilities |
| `packages/admin/src/lib/server/docker.ts` | Docker Compose shell-out wrapper |
| `packages/admin/src/lib/types.ts` | Shared TypeScript types |
| `packages/admin/src/lib/auth.ts` | Auth utilities |
| `packages/admin/src/lib/api.ts` | API call functions |
| `packages/admin/src/lib/opencode/client.server.ts` | OpenCode client wrapper |
| `core/guardian/src/server.ts` | HMAC-signed message guardian |
| `packages/channels-sdk/src/logger.ts` | Shared logger (createLogger factory) |
| `assets/` | Bundled compose files, Caddyfile |
| `registry/` | Channel registry (channel definitions pointing to published images) |
| `packages/assistant-tools/AGENTS.md` | Assistant persona and operational guidelines |
| `packages/assistant-tools/src/index.ts` | Plugin entry — registers all tools, plugins, skills |
| `.opencode/opencode.json` | OpenCode project configuration |