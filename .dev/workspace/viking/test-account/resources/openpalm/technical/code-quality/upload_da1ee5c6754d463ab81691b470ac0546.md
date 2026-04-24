## Core goals

This code-quality contract exists to guarantee:

1. **Maintainable modules by default.** Keep files small, focused, and cohesive so behavior is easy to locate and change.
2. **Type safety across boundaries.** Treat all external input as untrusted and validate/narrow before use.
3. **Predictable runtime behavior.** Prefer explicit data flow and deterministic side effects over hidden mutation.
4. **Framework-native patterns first.** Use Bun, SvelteKit, and platform APIs directly before introducing abstractions.
5. **Fast feedback loops.** Favor tooling and structure that keep `bun test`, `npm run check`, and local development quick.
6. **Secure-by-default implementation details.** Ensure auth, secrets handling, and request validation are never optional.

---

## Engineering invariants

These are hard constraints for implementation quality:

1. **Strict TypeScript only.** No `any` for untrusted data; use `unknown` + type guards or schema validation.
2. **Single-responsibility server modules.** Route handlers orchestrate; reusable business logic lives in server libraries.
3. **No hidden global state.** Shared state must be explicit, typed, and scoped to clear ownership boundaries.
4. **Guard-and-return error flow.** Validate/auth early and return structured errors immediately.
5. **Stable contracts at service edges.** Guardian and API payloads must use versioned, well-typed shapes.
6. **Security checks are non-bypassable.** Authentication, authorization, replay/rate controls, and auditing stay on every relevant path.

---

## Bun quality contract (guardian + channel services)

### 1) Runtime and module discipline

* Use ESM consistently with explicit `.js` relative imports.
* Keep startup paths minimal and side effects intentional.
* Prefer built-in Bun/standard APIs before adding dependencies.

### 2) HTTP and middleware boundaries

* Keep request parsing, auth verification, and domain logic separated.
* Centralize shared response/error helpers for consistent status codes and payloads.
* Include request identifiers in logs and error responses when applicable.

### 3) Reliability and observability

* Log structured events for ingress decisions (accept/reject/rate-limit/replay).
* Fail closed on malformed signatures, timestamps, and required headers.
* Keep tests close to critical security logic and edge-case behavior.

---

## SvelteKit quality contract (UI + admin API)

### 1) Route and library separation

* `+server` routes perform transport concerns; core business logic belongs in `$lib/server/*`.
* Reuse typed helper functions for auth checks, JSON parsing, and error responses.
* Keep page/load code focused on view-model assembly, not operational side effects.

### 2) Component design

* Keep Svelte components presentational where possible; move imperative logic to utilities/stores.
* Use explicit prop and event contracts; avoid implicit cross-component coupling.
* Favor small, composable components over large monolithic views.

### 3) Data and state hygiene

* Validate server inputs before state mutation or shell-out operations.
* Model async outcomes with discriminated unions for predictable UI states.
* Keep sensitive values server-only; never leak secrets through client bundles.

---

## Delivery and review checklist

* **Type correctness:** `npm run check` passes for UI code.
* **Behavior correctness:** `bun test` covers security-critical branches in guardian/channel code.
* **Contract correctness:** filesystem, guardian ingress, and assistant-isolation rules from `docs/core-principles.md` remain intact.
* **Change clarity:** each PR explains intent, risk, and rollback approach in plain language.
