# Contributing to OpenPalm

---

## Dev Environment Setup

See [CLAUDE.md](../CLAUDE.md) for the full list of build and test commands, architecture rules, and the delivery checklist that every change must satisfy before merging.

Quick reference:

```bash
# Clone and bootstrap
git clone https://github.com/itlackey/openpalm.git
cd openpalm

# Install git hooks (pre-commit secret scanning)
./scripts/install-hooks.sh

# Install varlock for comprehensive secret scanning (optional but recommended)
openpalm install

# Admin UI
cd packages/admin && npm install && npm run dev

# Guardian
cd core/guardian && bun install && bun run src/server.ts

# Dev stack (pull images)
bun run dev:setup   # create .dev/ dirs, seed configs
bun run dev:stack   # start the full stack
```

---

## Pre-commit Secret Scanning

OpenPalm uses [varlock](https://varlock.dev) to scan for secrets before each commit. The schema at `assets/secrets.env.schema` defines the patterns to detect.

### Install varlock

```bash
curl -fsSL https://varlock.dev/install.sh | sh
```

### Set up the pre-commit hook

```bash
./scripts/install-hooks.sh
```

The hook uses two strategies depending on what's available:

1. **varlock scan** (preferred) — resolves actual `@sensitive` values from your local `secrets.env` and searches the working tree (all tracked files) for those literal values. Catches any secret format, not just known prefixes. Requires `openpalm install` to install the varlock binary.
2. **grep fallback** — pattern-matches staged additions for known provider key formats (OpenAI `sk-*`, Groq `gsk_*`, Google `AIza*`). Used when varlock is not installed.

CI uses grep patterns on the PR diff (see `.github/workflows/ci.yml`) since there are no real secrets in the Actions environment. The pre-commit hook is where varlock scan provides the most value — it catches your actual secret values regardless of format.

### Why this matters

`CONFIG_HOME/secrets.env` holds API keys and auth tokens. The `.env.schema` files are safe to commit (they contain no values), but an accidental `git add secrets.env` or a key pasted into source code would be caught by the hook before reaching the remote.

---

## Architecture Rules

All contributions must comply with [`docs/technical/core-principles.md`](technical/core-principles.md). Key invariants:

- Admin is the sole Docker orchestrator. No other component gets the Docker socket.
- All channel traffic enters through the guardian (HMAC, replay protection).
- `CONFIG_HOME` is user-owned. Lifecycle operations only seed missing defaults — never overwrite.
- No shell interpolation in Docker commands. Use `execFile` with argument arrays.
- Follow the Docker dependency resolution pattern in [`docs/technical/docker-dependency-resolution.md`](technical/docker-dependency-resolution.md).

## Delivery Checklist

Before opening a pull request:

- [ ] `cd packages/admin && npm run check` passes
- [ ] `cd core/guardian && bun test` passes
- [ ] No new dependency duplicates a built-in Bun or platform capability
- [ ] Filesystem, guardian ingress, and assistant-isolation rules remain intact
- [ ] Errors and logs are structured and include request identifiers where applicable
- [ ] No secrets leak through client bundles or logs
- [ ] Docker builds follow the dependency resolution pattern
