## Tier 1: Type Checking & Linting

**Time:** ~10s | **Prerequisites:** None

```bash
bun run check    # svelte-check + TypeScript + sdk tests
```

Validates type correctness across all SvelteKit admin code and channels-sdk.

---

## Tier 2: Unit Tests

**Time:** ~30s | **Prerequisites:** None

```bash
# All non-admin packages (channels-sdk, guardian, channel-*, cli)
bun run test

# Admin unit tests (Vitest — server + browser)
bun run admin:test:unit

# Or run individually:
bun run sdk:test          # packages/channels-sdk (3 test files)
bun run guardian:test     # core/guardian security tests (1 file)
bun run cli:test          # packages/cli (1 file)
```

**What it validates:** SDK contracts, guardian HMAC/replay/rate-limiting, channel adapters, CLI parsing, admin server logic (docker wrapper, helpers, secrets, env management), admin client components.

**Test count:** ~572 admin unit tests + ~112 guardian/sdk/channel/cli tests.

---

## Tier 3: Browser Contract Tests (Mocked)

**Time:** ~2min | **Prerequisites:** Admin build (`bun run admin:build`)

```bash
bun run admin:test:e2e:mocked
```

Runs Playwright against a built admin app with mocked API endpoints. Tests setup wizard and UI contracts without depending on live backend services.

Use `bun run admin:test` to run both unit + e2e together (builds automatically).

---

## Tier 4: Stack Integration Tests

**Time:** ~1min | **Prerequisites:** Running compose stack

```bash
# 1. Start the dev stack
bun run dev:build          # to rebuild images

# 2. Run integration Playwright tests (no browser route mocks)
bun run admin:test:e2e
```

**What it validates:**
- OpenCode web UI accessible on `:4096`
- OpenMemory CRUD operations via `:8765`
- OpenCode API session management
- Memory Ollama integration (config read/write via admin API)

**Tests gated by:** `RUN_DOCKER_STACK_TESTS=1` env var (stack-only groups are skipped otherwise).

**Important:** Always use `bun run admin:test:e2e` (not `npx playwright test` directly) to avoid Playwright version conflicts between root and admin `node_modules`.

**Files:** `e2e/opencode-ui.test.ts`, `e2e/memory-config.test.ts`, `e2e/assistant-pipeline.test.ts`

---

## Tier 5: LLM Pipeline Tests

**Time:** ~1min | **Prerequisites:** Running stack + LLM provider (Ollama or Model Runner)

```bash
bun run admin:test:e2e
```

**What it validates:**
- Full assistant message pipeline (send message → LLM inference → response)
- Memory integration end-to-end (assistant adds memory via `memory-add` tool, recalls via `memory-search`)
- Embedding pipeline

**Model prerequisites:** Ollama with models available, or Docker Model Runner with packaged GGUF models:
- Qwen3.5-4B or equivalent (system LLM)
- nomic-embed-text or bge-base-en-v1.5 (embeddings, 768 dims)

**Files:** `e2e/assistant-pipeline.test.ts` (groups 5-6)

**No-skip expectation:** `bun run admin:test:e2e` sets `RUN_DOCKER_STACK_TESTS=1` and `RUN_LLM_TESTS=1` by default and should run only integration tests with no browser-route mocks.

---