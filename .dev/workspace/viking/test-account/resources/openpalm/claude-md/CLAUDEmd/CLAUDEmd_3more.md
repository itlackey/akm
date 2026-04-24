# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical: Architectural Authority

**All work MUST comply with [`docs/technical/core-principles.md`](docs/technical/core-principles.md).** This document is the authoritative source of architectural rules for the project. Before making changes, verify alignment with:
- The 9 core goals (file-drop modularity, no template rendering, never overwrite user files, etc.)
- The 4 security invariants (admin sole orchestrator, guardian-only ingress, assistant isolation, LAN-first)
- The filesystem contract (CONFIG_HOME / DATA_HOME / STATE_HOME tier boundaries)
- The volume-mount contract (Compose multi-file, Caddy import, OpenCode config precedence)

## Build & Dev Commands

```bash
# Admin (SvelteKit admin + API)
cd packages/admin && npm install && npm run dev     # Dev server on :8100
npm run build                                  # Production build
npm run check                                  # svelte-check + TypeScript

# Guardian (Bun)
cd core/guardian && bun install && bun run src/server.ts

# Channel Chat (Bun)
cd packages/channel-chat && bun install && bun run src/index.ts

# Root shortcuts
bun run admin:dev        # Runs admin dev from root (packages/admin)
bun run admin:build      # Builds admin from root (packages/admin)
bun run admin:check      # svelte-check + TypeScript for admin
bun run admin:test       # Runs vitest + playwright (admin, requires build)
bun run admin:test:unit  # Runs vitest in non-watch mode (CI-friendly)
bun run admin:test:e2e   # Runs integration Playwright tests only (no @mocked browser routes)
bun run admin:test:e2e:mocked # Runs mocked browser contract Playwright tests
bun run guardian:dev     # Runs guardian server (core/guardian)
bun run guardian:test    # Runs guardian tests (core/guardian)
bun run sdk:test         # Runs channels SDK tests (packages/channels-sdk)
bun run channel:chat:dev    # Runs chat channel dev server
bun run channel:api:dev     # Runs api channel dev server
bun run channel:discord:dev # Runs discord channel dev server
bun run cli:test         # Runs CLI tests (packages/cli)
bun run admin:test:stack # Stack-dependent integration tests (needs running stack + ADMIN_TOKEN)
bun run admin:test:llm   # LLM pipeline tests (needs stack + ADMIN_TOKEN + API keys)
bun run dev:setup        # Creates .dev/ dirs, seeds configs
bun run dev:stack        # Starts dev stack (pull images)
bun run dev:build        # Starts dev stack (build from source via compose.dev.yaml)
bun run check            # Runs admin:check + sdk:test

# Dev environment setup
./scripts/dev-setup.sh --seed-env       # Creates .dev/ dirs, seeds configs

# Docker (local build) — shortcut: bun run dev:build
# Manual equivalent with channel overlay:
docker compose --project-directory . \
  -f assets/docker-compose.yml \
  -f compose.dev.yaml \
  --env-file .dev/state/artifacts/stack.env \
  --env-file .dev/state/artifacts/secrets.env \
  up --build -d
```