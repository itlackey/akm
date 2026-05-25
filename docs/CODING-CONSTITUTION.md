# AKM Coding Constitution

> **Why this exists.** In May 2026 we estimated a one-file SQLite move at
> 32–49 hours touching 500+ LOC across 40 files. That blast radius is
> shotgun surgery — a symptom of abstractions that have leaked everywhere
> instead of being encapsulated behind small interfaces. This constitution
> is the post-mortem rule set: rules that prevent the next sprawl. See
> issue [#490](https://github.com/itlackey/akm/issues/490) for the full
> refactor plan and [#489](https://github.com/itlackey/akm/issues/489) for
> the trigger case.

> **Audience.** Humans AND coding agents. Every PR — and every agent
> task — is reviewed against the rules below. The mechanical rules
> (`§ Mechanical Rules`) are enforced by `bun run lint`; the judgment
> rules (`§ Principles`, `§ Patterns to Use`, `§ Anti-Patterns`) are
> enforced in review.

---

## § Principles (judgment, not mechanical)

1. **Cohesion over convenience.** Files ≤ 600 LOC; modules ≤ 1,000.
   If you hit the cap, split before merging. *(Martin, Clean Code §3.)*

2. **Single source of truth.** Concepts (asset types, command names,
   exit codes, output formats) live in exactly one `as const`
   declaration. Types and runtime sets are *derived* from it; the
   list never appears in two places. *(Hunt & Thomas, Pragmatic
   Programmer — DRY.)*

3. **Branded primitives at boundaries.** Anything with rules attached
   (`AssetRef`, `AbsolutePath`, `ScopeKey`, `SemVer`) gets a brand or
   newtype. Raw `string` for these concepts is a code-review block.
   *(Domain primitives / Tiny Types — Dan Bergh Johnsson.)*

4. **Strategy over switch.** If you write `switch (x)` or
   `if (type === "...")` with more than three arms, register a
   strategy instead. New variants must not require editing the central
   switch. *(GoF Strategy + Open/Closed Principle.)*

5. **Inject seams, hide internals.** Test seams live as named optional
   fields on a Parameter Object, not extra positional args. The seam's
   *existence* is documented in the type; its *use* is opt-in.
   *(Feathers, Working Effectively with Legacy Code.)*

6. **Repository pattern for durable data.** Code that reads/writes a
   SQLite table or a JSONL file does so through a typed repository.
   No `Database` handle escapes the `src/storage/` boundary. No
   `db.prepare(...)` outside `src/storage/repositories/*.ts`.

7. **Pure handlers in `commands/`; framework wrappers only in `cli.ts`.**
   `src/commands/<verb>.ts` exports `akm<Verb>(opts)` — pure async
   function, no citty, no `process.exit`. `src/cli.ts` wraps it in a
   `defineCommand`. This pattern already works for `tasks.ts:1-30`
   and `agent-dispatch.ts`. Apply universally.

8. **Path discipline at the edge.** Every public function takes
   `AbsolutePath`; conversion from user input (`string`) happens once
   at the CLI boundary in `cli/`. After that, paths are typed.

---

## § Patterns to Use

When you reach for these, the constitution is on your side:

9. **Parameter Object** for any function over 4 parameters. Split by
   mutability when natural — an immutable plan + a mutable context.
   *(Fowler.)*

10. **Builder** for option records with > 8 optional fields. (See
    `AkmImproveOptions` in `src/commands/improve.ts:73` — a builder
    target.)

11. **Registry / Plugin** for per-asset-type strategies. Prior art:
    `src/core/asset-spec.ts:registerAssetType`. Each asset type
    self-registers a `{ render, shape, format, write, prompt }`
    bundle.

12. **Single emit pipeline.** `emitResult({ ok, command, payload })`
    for both success AND error paths. The envelope stamper
    (`schemaVersion` + `shape`) applies symmetrically. No
    hand-rolled `console.log(JSON.stringify(...))` sites.

13. **Centralised JSON file IO.** `readJsonFile<T>(path, schema)` /
    `writeJsonFile(path, data)` route through one place so atomic
    writes, fsync (#472), and parse errors are consistent.

14. **Frontmatter via `core/asset-serialize.ts` only.** Never clone
    the serializer; fix the parser if it diverges. The lesson from
    `knowledge:projects/akm/asset-writers-investigation/00-synthesis`.

15. **External templates.** Markdown/XML/prompt strings over 10 lines
    live in sibling `*.md` / `*.xml` files, not inline. AGENTS.md
    already says this; we promote it to a rule.

16. **Exhaustive `switch` with `assertNever(x)`.** Every discriminated
    union switch ends with a default that calls
    `assertNever(value)` — compile-time guarantee that new variants
    visit every site.

17. **Storage location resolver.** Paths come from
    `src/storage/locations.ts` (single resolver, frozen at boot).
    Callers receive paths, never compose them with
    `path.join(getDataDir(), "x.db")`.

18. **Test isolation via `withIsolatedAkmStorage`.** All tests use
    the helper from `tests/_helpers/sandbox.ts`. Raw `mkdtempSync`
    + manual env-var pokes is forbidden outside `_helpers/`.

---

## § Anti-Patterns Explicitly Forbidden

These fail PR review. The mechanical-rule lint blocks most of them;
the rest live here as named anti-patterns.

19. **God-class growth.** No edit may push `cli.ts`, `improve.ts`,
    `consolidate.ts`, `distill.ts`, `reflect.ts`, `setup.ts`,
    `text.ts`, `indexer.ts`, `state-db.ts`, `proposals.ts`, or
    `wiki.ts` *larger*. New code lives in extracted siblings.

20. **Stringly-typed dispatch.** A new branch on `type === "..."`
    or `kind === "..."` requires a registered Strategy, not a new
    `case`.

21. **Duplicate helpers across modules.** If you'd inline-implement
    something a sibling already exports, fix the export. Cloning
    a helper to work around a bug in the original is the bug — fix
    the original.

22. **Hidden mutation channels.** Functions returning `void` while
    mutating an `actions[]` or `recentErrors{}` passed by reference
    are forbidden. Return the delta; let the caller merge.

23. **Module-level mutable state in `src/`.** No global singletons,
    no top-level `let`. Tests already enforce this for the harness
    (`tests/_preload.ts`); the same rule applies to source.

24. **Reading env vars outside `src/storage/env.ts`.** `process.env.XDG_*`
    and `process.env.AKM_*` are resolved exactly once at boot, frozen
    into a `StorageLocations` object, and passed via DI. Forbidden
    elsewhere.

25. **Importing `bun:sqlite` outside `src/storage/`.** The SQLite
    detail is hidden behind repositories. No exceptions.

---

## § Mechanical Rules (lint-enforced)

`bun run lint` blocks PRs that violate any of:

26. Files > 1,000 LOC. *(Hard cap; existing offenders are
    grandfathered with a list in `tests/_lint/grandfathered.json`.
    The list shrinks; it never grows.)*

27. Functions > 80 LOC. *(Martin, Clean Code threshold.)*

28. Functions > 5 positional parameters, or > 8 optional fields in a
    record without a Builder.

29. Raw `process.exit()` outside `src/cli.ts` entry shim.

30. `mkdtempSync()` outside `tests/_helpers/`.

31. `ref: string` parameter declarations in `src/` (use `AssetRef`).

32. `console.log(JSON.stringify({ok: false ...}))` / `console.error(...)`
    bypass of `emitJsonError`.

33. `db.prepare(...)` or `new Database(...)` outside
    `src/storage/repositories/` / `src/storage/engines/`.

34. `process.env.XDG_*` / `process.env.AKM_*_DIR` access outside
    `src/storage/env.ts`.

35. New `case "command-name":` branches in `shapeForCommand` /
    `formatPlain` (use the registry pattern).

---

## References

| Source | What it covers here |
|---|---|
| Martin Fowler, *Refactoring* (2nd ed.) | Parameter Object, Extract Class, Replace Type Code with Subclasses (asset-type registry), Replace Conditional with Polymorphism |
| Robert C. Martin, *Clean Code* | Function size, parameter count, single responsibility |
| Gamma et al., *Design Patterns* | Strategy, Registry, Builder, Mediator (the `output()` pipeline) |
| Michael Feathers, *Working Effectively with Legacy Code* | Seams, test isolation, characterization tests |
| Hunt & Thomas, *The Pragmatic Programmer* | DRY, orthogonality, single source of truth |
| Dan Bergh Johnsson, *Domain-Driven Design — Tiny Types* | Branded primitives, `AssetRef` / `AbsolutePath` |
| Wirfs-Brock & McKean, *Object Design: Roles, Responsibilities, and Collaborations* | Repository, Service-Layer separation |

## How this document is enforced

- **Code review:** every PR description has a "Constitution check" box;
  reviewers flag rule violations.
- **Lint:** `bun scripts/lint-constitution.ts` runs in CI; rules 26–35
  are mechanical.
- **AGENTS.md:** linked at the top so agent-driven coding tasks see
  the rules in their hints output (`akm hints --full`).
- **Living document:** edits to this file require a one-line PR
  description naming the rule added/changed/removed. The doc moves
  forward, never sideways.

## Companion plans

- **Refactor master tracker:** [#490](https://github.com/itlackey/akm/issues/490)
- **Triggering case (storage layout):** [#489](https://github.com/itlackey/akm/issues/489)
- **Lessons informing this doc:**
  - `knowledge:projects/akm/asset-writers-investigation/00-synthesis` (writer-refactor lessons)
  - Issues #467, #469, #471, #472, #473 (the 0.8.0-rc.6 cycle that exposed the encapsulation gaps)
