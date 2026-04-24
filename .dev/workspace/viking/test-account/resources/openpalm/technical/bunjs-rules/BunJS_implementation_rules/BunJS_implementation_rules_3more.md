## BunJS implementation rules

This document defines Bun-specific implementation rules for OpenPalm's **Bun
services only**: `core/guardian/`, `channels/*`, `packages/channels-sdk/`, and any
Bun-based utilities. It does **not** apply to the admin service (`packages/admin/`),
which is a SvelteKit/Node.js app and follows Node.js and SvelteKit conventions
(see `docs/technical/sveltekit-rules.md`).

It complements `docs/technical/core-principles.md` and `docs/technical/code-quality-principles.md`.

### 1) Core Bun design rules

1. Prefer Bun and Web Platform built-ins before adding third-party runtime dependencies.
2. Keep server entrypoints thin: parse request, validate/auth, call domain logic, return structured response.
3. Fail closed on auth/signature/timestamp errors and return explicit HTTP status codes.
4. Keep side effects explicit and isolated (disk writes, shell-outs, network calls).
5. Use strict TypeScript with `unknown` at untrusted boundaries and narrow before use.

### 2) Dependency policy

Before adding any dependency, confirm there is no Bun or platform-native API that already solves the problem.
New dependencies must be justified by a concrete gap (capability, compatibility, or maintenance).