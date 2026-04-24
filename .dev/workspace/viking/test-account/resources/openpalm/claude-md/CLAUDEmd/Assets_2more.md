## Assets

Core infrastructure templates live in `assets/`:
- `docker-compose.yml` — Core service definitions
- `Caddyfile` — Reverse proxy configuration
- `secrets.env` — Environment variable reference

These are bundled into the admin image at build time via Vite's `$assets` alias and downloaded from GitHub during upgrades. See [`assets/README.md`](assets/README.md).

## Test Suites

| Runner | Command | Scope |
|--------|---------|-------|
| `bun test` (root) | `bun run test` | channels-sdk, guardian, cli, all channel packages — excludes packages/admin |
| `bun test` (sdk) | `bun run sdk:test` | packages/channels-sdk unit tests |
| `bun test` (guardian) | `bun run guardian:test` | core/guardian security tests |
| `bun test` (cli) | `bun run cli:test` | packages/cli tests |
| Vitest (admin) | `bun run admin:test:unit` | packages/admin unit + browser component tests |
| Playwright (admin integration) | `bun run admin:test:e2e` | packages/admin integration tests (no browser route mocks) |
| Playwright (admin mocked) | `bun run admin:test:e2e:mocked` | packages/admin mocked browser contract tests |
| Both admin | `bun run admin:test` | Vitest then Playwright (requires running build) |
| Playwright (stack) | `bun run admin:test:stack` | Stack-dependent integration tests (OpenCode, OpenMemory, Caddy) |
| Playwright (LLM) | `bun run admin:test:llm` | LLM-dependent pipeline tests (message processing, memory integration) |
| Type check + sdk | `bun run check` | admin:check (svelte-check) + sdk:test |

> Admin uses Vitest (unit/browser) and Playwright (e2e). These require different runners from Bun.
> Use `bun run test` (not bare `bun test`) from the repo root — the script filters to non-admin dirs.
>
> **Stack-dependent integration tests** (Playwright files gated by `RUN_DOCKER_STACK_TESTS=1`) require a running compose stack and are skipped by default. Run with:
> `RUN_DOCKER_STACK_TESTS=1 ADMIN_TOKEN=dev-admin-token bun run admin:test:e2e`
> **Important:** Always use `bun run admin:test:e2e` (not `npx playwright test` directly) to avoid Playwright version conflicts.
> Mocked browser-route coverage (wizard/UI contracts) runs separately via `bun run admin:test:e2e:mocked`.
> Integration suite includes: `memory-config.test.ts` (OpenMemory integration + admin API), `opencode-ui.test.ts` (OpenCode web UI on :4096 + Caddy proxy), `assistant-pipeline.test.ts` (OpenCode API, OpenMemory CRUD, message pipeline, memory integration).