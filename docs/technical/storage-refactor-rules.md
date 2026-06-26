# Storage Refactor — Rules (binding for implementers AND review agents)

Primary purpose: **maintain functionality** while refactoring the storage layer into high-quality, production-ready code using known design patterns and best practices — healthy, readable, maintainable. These rules are binding for every step (A–E) and for any agent reviewing the work.

## Behavior

1. **Behavior-preserving by default.** Refactors must not change observable behavior. The ONLY allowed behavior changes are the explicitly-listed integrity fixes, each of which must ship with a test that proves the new behavior:
   - Step A: removing the nuclear-drop on version mismatch (no more whole-index wipe + paid re-embed).
   - Step B: embedding purge always backs up first (no silent paid-corpus loss).
   - Step C: per-phase improve concurrency removed (single-writer-local model).
   Any other behavior change is a bug — stop and flag it.

## Quality gate (every commit)

2. **Zero tolerance:** `bun run check` style gate — biome 0 errors/0 warnings, `tsc --noEmit` 0 errors, custom lints pass, and the affected test suites pass. No commit with a red or warning state. No "fix it later."
3. **Net subtraction.** Each step must remove more than it adds (or be net-neutral for a pure rename). If a change ADDS complexity/lines/abstraction, justify it explicitly or don't do it. Track the LOC delta per step.
4. **No speculative code.** No Postgres implementation, no DI container, no "future-proofing" beyond the already-agreed provider seam. Build for today's single-writer-local SQLite reality.

## Code health

5. **Known patterns, named.** State the pattern each refactor applies (append-only migration ledger, factory, helper extraction, application-side join, etc.). Don't invent bespoke structures where a standard one fits.
6. **Small, single-purpose units.** Break god-functions into focused functions with clear names. No function should mix unrelated responsibilities.
7. **No dead code, no commented-out code, no orphan exports.** If something becomes unused, delete it (and its tests/imports) in the same step.
8. **Readable over clever.** Match surrounding style. Comments explain *why*, not *what*.

## Process

9. **One focused commit per step** with a clear message describing the pattern applied and the LOC delta. Each step is independently revertible.
10. **Verify before asserting.** Every claim about the code cites the file:line you actually read. Run the tests; don't assume.
11. **Sequence for safety, not for the label.** Dependency-safe order may differ from A–E labels; note when it does.

## Review-agent rules (same as above, plus)

12. **Independently verify functionality is preserved** — read/run the relevant tests, trace the before/after behavior, do not take the implementer's word.
13. **Hunt for:** behavior changes outside the allowed list (#1), net complexity ADDED, dead/orphan code left behind, a pattern misapplied, any `bun run check` violation, any speculative code.
14. **Default to skepticism.** Confirm a step only if you verified it against the code, not the description.
