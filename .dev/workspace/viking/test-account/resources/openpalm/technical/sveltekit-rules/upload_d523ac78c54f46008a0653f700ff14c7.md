## SvelteKit implementation rules

This document is a short SvelteKit-specific quality guide aligned with current Svelte/SvelteKit best practices and this repo's architecture contract in `docs/core-principles.md`.

**VERY IMPORTANT** The use of the $effect rune should be avoided and replaced with event handlers unless there is a solid justification to use $effect and approval to do so. Any instance of $effect should be treated as a bug to fix.

### 1) Server/client boundaries

1. Keep secrets and privileged operations server-only (`+page.server.ts`, `+layout.server.ts`, `+server.ts`, `$lib/server/*`).
2. Never import server-only modules into browser code.
3. Treat all request data (`params`, `url`, form data, JSON bodies) as untrusted and validate before use.

### 2) Data loading and mutations

1. Use `load` functions for data fetching and view-model assembly; avoid hidden side effects in `load`.
2. Prefer form actions and `+server.ts` endpoints for writes/mutations.
3. Keep mutations idempotent where possible and return predictable success/error shapes.

### 3) Routing and composition

1. Keep route files thin and move reusable logic into `$lib/server/*` or `$lib/*` helpers.
2. Use nested layouts to share data/UI concerns instead of duplicating route logic.
3. Use typed route contracts and generated SvelteKit types for params/data consistency.

### 4) UX and progressive enhancement

1. Build routes to work without JavaScript first, then enhance.
2. Use explicit loading/empty/error states for every async flow.
3. Keep components small and composable; pass explicit props/events rather than implicit coupling.

### 5) Reliability and observability

1. Apply guard-and-return flow for auth/validation failures.
2. Return consistent HTTP status codes and structured error payloads.
3. Include request identifiers in server logs/responses when available for traceability.

### 6) Delivery checklist

* `npm run check` passes for UI/type correctness.
* Changed routes and server helpers are covered by focused tests where available.
* No change violates filesystem/security/ingress rules in `docs/core-principles.md`.
