# SQLite Runtime Architecture Decision Record (#465)

**Date:** 2026-06-06
**Status:** Accepted
**Issue:** [#465 0.9.0: Bun/Node compatibility](https://github.com/itlackey/akm/issues/465)

## Context

The 0.9.0 cross-runtime stability release makes AKM run under standard Node.js
in addition to Bun. Most Bun-specific globals (`Bun.spawnSync`, `Bun.write`,
`Bun.resolveSync`, `Bun.semver`) have direct Node-compatible equivalents and
have been ported (see `src/core/runtime.ts` and the call sites it serves).

The remaining — and by far the largest — runtime dependency is **`bun:sqlite`**.
AKM stores its entire index (frontmatter, FTS5, vector/embedding, and graph
tables) in a single SQLite database accessed through Bun's built-in
`bun:sqlite` module. As of this release, `bun:sqlite` is imported directly in
**26 source files**, not the ~11 originally estimated in the issue:

```
src/cli.ts                         src/indexer/db-search.ts
src/commands/extract.ts            src/indexer/db.ts
src/commands/graph.ts              src/indexer/graph-boost.ts
src/commands/health.ts             src/indexer/graph-db.ts
src/commands/history.ts            src/indexer/graph-extraction.ts
src/commands/improve.ts            src/indexer/index-context.ts
src/commands/info.ts               src/indexer/indexer.ts
src/commands/search.ts             src/indexer/llm-cache.ts
src/commands/show.ts               src/indexer/memory-inference.ts
src/core/events.ts                 src/indexer/ranking-contributors.ts
src/core/state-db.ts               src/indexer/ranking.ts
src/workflows/db.ts                src/indexer/search-hit-enrichers.ts
src/workflows/runs.ts              src/indexer/staleness-detect.ts
                                   src/indexer/usage-events.ts
```

These files use both the `Database` class **and** `bun:sqlite`-specific types
(notably `SQLQueryBindings`, referenced in inline `import("bun:sqlite")` type
positions throughout `src/indexer/db.ts`). A faithful Node fallback would mean
introducing `better-sqlite3` (a native addon with a near-identical but not
identical API), writing a thin driver-abstraction layer, threading a shared
binding type through every call site, and re-validating FTS5 + the `sqlite-vec`
extension load path under the new driver. That is a multi-PR refactor with real
behavioural risk to the search/index core.

## Decision

**For 0.9.0, the SQLite layer remains Bun-only.** AKM's CLI continues to
require the Bun runtime (or the prebuilt binary) for any command that touches
the index database. The wrong-runtime guard in `src/cli.ts` stays in place and
exits early with install guidance when `Bun` is not present.

The Bun-specific *non-SQLite* APIs are ported to Node-compatible code paths in
this release so that the eventual switch to a cross-runtime SQLite driver is the
**only** remaining blocker to full Node support, rather than one of many.

## Rationale

- **Scope / risk.** Touching 26 files and the binding type system, plus
  swapping the FTS5 and vector-extension load path onto a native addon, is not
  safely landable in the 0.9.0 stability window. The remaining Bun globals are
  small, isolated, and individually verifiable; SQLite is not.
- **`better-sqlite3` is a native addon.** It requires per-platform prebuilds or
  a toolchain at install time, which complicates the npm-install and prebuilt-
  binary distribution stories. That tradeoff deserves its own evaluation rather
  than being bundled into a compatibility sprint.
- **Bun's `bun:sqlite` is statically importable only under Bun.** A dynamic,
  runtime-selected driver import is the correct shape for an abstraction, and
  designing it well is a deliberate task, not a mechanical find-and-replace.

## Consequences

- AKM 0.9.0 runs under Node for everything that does **not** open the index DB,
  but the CLI entrypoint still gates on Bun because nearly every command reaches
  the database. In practice, 0.9.0 ships the non-SQLite ports as
  forward-progress while remaining Bun-required end to end.
- A future cross-runtime SQLite abstraction should:
  1. Introduce a single `src/indexer/sqlite-driver.ts` seam exposing the minimal
     `Database`/`Statement` surface AKM actually uses, plus a runtime-neutral
     bindings type to replace `bun:sqlite`'s `SQLQueryBindings`.
  2. Select `bun:sqlite` vs `better-sqlite3` via `isBun()` (already available in
     `src/core/runtime.ts`) behind a dynamic import.
  3. Re-validate FTS5 and the `sqlite-vec` extension load under both drivers.
  4. Relax the `src/cli.ts` runtime guard to allow Node once the seam lands.

## CI

`bun test` is the supported test runner. A Node test lane can run only the
suites that do not require `bun:sqlite` until the driver seam above exists; a
full Node matrix is blocked on that work and is intentionally out of scope here.
