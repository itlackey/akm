> **ARCHIVED 2026-07-05 (meta-review 14).** Shipped: `InstallKind` is live in `src/registry/types.ts`. Retained as a design-decision record.
> Current truth = the code under `src/registry/`. Git history is the recovery path.

# R5 — Finalized design: separate the install discriminator, move `buildInstallRef`, no table

**Verdict (one line):** No descriptor table. Introduce a 4-member `InstallKind` install discriminator (severing the misleading `KitSource = SourceSpec["type"]` alias on install-only structures), move `buildInstallRef` from `static-index.ts` next to its inverse `parseRegistryRef` in `resolve.ts`, and add compile-time exhaustiveness to the two genuinely-uniform install switches. Everything else is left as-is. Net ≈ −8 to −12 LOC, coupling removed, behavior byte-identical.

All three independent designs (minimalist / domain-modeler / failure-analyst) converged on this shape and **all three answered `isTableJustified: false`**. This document is the synthesis, re-verified against the code.

---

## 1. The two-domains finding + `KitSource`-alias verdict (with receipts)

There are **two distinct source-kind domains** that share member *names* but are **not the same set**:

| Domain | Members | Defined / discriminator | Sites |
|---|---|---|---|
| **INSTALL / REGISTRY** | `npm \| github \| git \| local` (**4**) | the actual `ParsedRegistryRef` discriminator | 1–4 |
| **CONFIG / STASH** | `filesystem \| git \| npm \| github \| website \| local` (**6**) | `SourceSpec["type"]` | 5 |

They overlap only on `{npm, github, git, local}`; CONFIG adds `{filesystem, website}`, which the registry parser never produces and the lockfile reader actively rejects.

### Receipt A — `SourceSpec` is 6 members
`src/core/config/config-types.ts:662`:
```ts
export type SourceSpec =
  | { type: "filesystem"; path: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "npm"; package: string; version?: string }
  | { type: "github"; owner: string; repo: string; ref?: string }
  | { type: "website"; url: string; maxPages?: number }
  | { type: "local"; path: string };
```

### Receipt B — `ParsedRegistryRef` is exactly 4 members
`src/registry/types.ts:26-51`: each `Parsed*Ref` re-declares `source` as a narrow literal (`"npm"`, `"github"`, `"git"`, `"local"`), overriding `RegistryRefBase.source: KitSource`. So `ParsedRegistryRef["source"]` resolves to the 4-set regardless of the base alias.

### Receipt C — compiler probe (run live in this repo)
A probe file `src/__r5probe.ts` was compiled with `bunx tsc -p tsconfig.json --noEmit`:
```ts
const a: ParsedRegistryRef["source"] = "website" as KitSource;  // line 4
const b: KitSource = "website";                                  // line 5
const c: KitSource = "filesystem";                               // line 6
```
Result:
```
src/__r5probe.ts(4,7): error TS2322: Type '"filesystem" | "git" | "npm" | "github" | "website" | "local"'
  is not assignable to type '"git" | "npm" | "github" | "local"'.
```
Line 4 **errors** (proving `ParsedRegistryRef["source"]` is the 4-set); lines 5–6 **pass** (proving `KitSource` is the 6-set). The probe was deleted after the run.

### Receipt D — the install domain only ever holds 4-set values
- `src/registry/providers/static-index.ts:366` `asSource()` returns exactly `"npm" | "github" | "git" | "local" | undefined`.
- `static-index.ts:34` `RegistryStashEntry.source` is independently re-declared as `"npm" | "github" | "git" | "local"`.
- `src/integrations/lockfile.ts:125-126` the lockfile *reader* validates `["npm","github","git","local"].includes(obj.source)` — it **rejects** `filesystem`/`website` at runtime.
- All writers of `ResolvedRegistryArtifact.source` / `InstalledStashEntry.source` (`resolve.ts:156/176/210/227/264/393/411/429/443/465`, `git-install.ts:47/54/79/140`, `npm.ts:118/173`, `sync-from-ref.ts:44`) produce only 4-set literals or `parsed.source`/`resolved.source` (themselves 4-set).
- `skills-sh.ts:104` emits `source: "github" as const`.

### Verdict on `KitSource = SourceSpec["type"]` (`src/registry/types.ts:18`)
**MISLEADING ALIAS bordering on a latent type-hole — not a hard compile error today only by accident.** Because `{npm,github,git,local} ⊂ {filesystem,git,npm,github,website,local}`, every install value is *assignable* to `KitSource`, so it compiles. But every install-only structure typed with the bare alias — `RegistryRefBase.source` (types.ts:21), `ResolvedRegistryArtifact.source` (:55), `InstalledStashEntry.source` (:64), `RegistrySearchHit.source` (:91), `lockfile.ts:33`, `sources/types.ts:151/245` — is silently typed **2 members too wide**. The smoking gun: `lockfile.ts:12-14` *comments* that `KitSource` is "the typed alias for the legacy install-source strings (`npm | github | git | local`)" — the comment describes the 4-set intent while the code delivers the 6-set. This over-widening is **exactly why "one table keyed by `KitSource`" could not gate** (see §5).

Note: `config-schema.ts:531` already hard-codes the 6-member `z.enum` independently, so the alias is not even the single source of truth it claims to be — config validation does not depend on it.

---

## 2. The exact recommended change

### 2.1 New type + re-point install-only fields (`src/registry/types.ts`)
Add a dedicated 4-member install discriminator and stop aliasing the install domain to the config union:
```ts
/** The install/registry source discriminator: exactly the kinds `parseRegistryRef` can emit. */
export type InstallKind = ParsedRegistryRef["source"]; // "npm" | "github" | "git" | "local"
```
Re-point the **install-only** `source` fields from `KitSource` to `InstallKind`:
- `RegistryRefBase.source` (types.ts:21)
- `ResolvedRegistryArtifact.source` (types.ts:55)
- `InstalledStashEntry.source` (types.ts:64)
- `RegistrySearchHit.source` (types.ts:91)
- `LockfileEntry.source` (`integrations/lockfile.ts:33`)
- `AddResponse.installed.source` (`sources/types.ts:151`)
- `UpdateResultItem.source` (`sources/types.ts:245`)

Deriving `InstallKind` from `ParsedRegistryRef["source"]` (rather than re-spelling the literals) means it stays automatically correct if a `Parsed*Ref` is added/removed — no second source of truth.

**Leave `KitSource = SourceSpec["type"]` in place** (it is the legitimate 6-member config discriminator), but it will no longer be imported by the install structures. Keep `RemoveResponse.removed.source: KitSource | string` (`sources/types.ts:226`) **unchanged** — it already widens to `string`, so it is sound and is a remove-path field, not an install discriminator. After the re-point, audit the remaining `KitSource` imports; if `registry/types.ts` no longer uses it internally, the local `import` line can stay only where still referenced (config side). Do not delete `KitSource` itself.

### 2.2 Move `buildInstallRef` to `resolve.ts` (co-locate with `parseRegistryRef`)
Delete the local definition at `static-index.ts:377-388` and add an **exported** function in `resolve.ts`, next to its inverse `parseRegistryRef`:
```ts
export function buildInstallRef(source: InstallKind, ref: string): string {
  switch (source) {
    case "npm":    return `npm:${ref}`;
    case "git":    return `git+${ref}`;
    case "local":  return `file:${ref}`;
    case "github": return `github:${ref}`;
  }
}
```
- Signature changes from `(source: string, ...)` to `(source: InstallKind, ...)`. Callers `static-index.ts:252` and `:303` pass `stash.source`, already typed `"npm"|"github"|"git"|"local"` (`RegistryStashEntry.source`, static-index.ts:34) — they type-check with zero widening.
- The old `default:` arm returned `` `github:${ref}` ``. It is rewritten as an **explicit `case "github"`** returning the byte-identical string. Because the param is now the closed 4-literal `InstallKind`, tsc proves the four cases are total — **no `default` needed, no `satisfies Record` needed**. This is the exhaustiveness the old `switch(source: string)` lacked.
- `static-index.ts` adds `import { buildInstallRef } from "../resolve";` (verify the relative path) and keeps its local `asSource()` as the runtime narrowing boundary; narrow `asSource`'s return type to `InstallKind` (its literal set is already exactly the 4).

### 2.3 Exhaustiveness on `resolveRegistryArtifact` (`resolve.ts:135`) — optional but recommended
Today it is an if/else chain ending in an unguarded `return resolveGithubArtifact(parsed)` (a silent catch-all). Once `parsed.source` is the closed `InstallKind`, this can be made a checked switch:
```ts
export async function resolveRegistryArtifact(parsed: ParsedRegistryRef): Promise<ResolvedRegistryArtifact> {
  switch (parsed.source) {
    case "npm":    return resolveNpmArtifact(parsed);
    case "local":  return resolveLocalArtifact(parsed);
    case "git":    return resolveGitArtifact(parsed);
    case "github": return resolveGithubArtifact(parsed);
  }
}
```
`parsed` narrows to the right `Parsed*Ref` in each arm, so the existing calls type-check. This is behavior-identical (github was already the fallthrough) and **adds the exhaustiveness the if/else lacked**: a future 5th kind would now fail to compile instead of silently routing to github. If keeping the if/else is preferred to minimize diff, that is acceptable — narrowing `parsed.source` to `InstallKind` is the load-bearing change; this switch is a clean-up bonus. Do **not** add a `default` arm (it would defeat exhaustiveness).

### 2.4 `syncFromRef` (`sync-from-ref.ts:20`) — keep if/else, drop the cast
Leave the dispatch exactly as-is, including the **deliberate `git || github` collapse to one handler** (`syncRegistryGitRef`) and the lazy `await import(...)` code-split boundaries. The only change: the trailing exhaustiveness guard currently casts to dodge the bad alias —
```ts
throw new UsageError(
  `No syncable provider for ref: ${ref} (source=${(parsed as { source: SourceSpec["type"] }).source})`,
);
```
Once `parsed.source` is `InstallKind` (4 members) and all four kinds are handled (`local`, `npm`, `git|github`), this branch is unreachable. Replace the cast-bearing throw with a real `never` exhaustiveness check:
```ts
const _exhaustive: never = parsed;
throw new UsageError(`No syncable provider for ref: ${ref}`);
```
This **deletes** the `(parsed as { source: SourceSpec["type"] })` cast and the `SourceSpec` import becomes unused here (remove it) — a net subtraction. Behavior is identical: the throw was already unreachable for real input.

---

## 3. Sites touched vs deliberately left

### Touched
| Site | Change | Reason |
|---|---|---|
| `src/registry/types.ts:18-24,55,64,91` | add `InstallKind`; re-point `RegistryRefBase`/`ResolvedRegistryArtifact`/`InstalledStashEntry`/`RegistrySearchHit` `.source` `KitSource→InstallKind` | sever the misleading alias on install-only structures (the root defect) |
| `src/registry/resolve.ts` | receive moved exported `buildInstallRef(source: InstallKind, ref)`; (optional) convert `resolveRegistryArtifact` if/else → exhaustive switch | co-locate install-ref grammar with its inverse parser; add exhaustiveness |
| `src/registry/providers/static-index.ts:252,303,366,377-388` | delete local `buildInstallRef`, import from `resolve.ts`; narrow `asSource()` return to `InstallKind` | a registry *provider* should not re-derive install-ref syntax |
| `src/sources/providers/sync-from-ref.ts:13,29-36` | replace `(parsed as { source: SourceSpec["type"] })` cast + throw with a `never` exhaustiveness check; drop now-unused `SourceSpec` import | the cast only existed to dodge the over-wide alias; keep the `git\|github` collapse |
| `src/integrations/lockfile.ts:11-14,33` | `LockfileEntry.source` `KitSource→InstallKind`; fix the stale comment | the lockfile reader already validates the 4-set at runtime (`:126`) |
| `src/sources/types.ts:5,151,245` | install-domain `.source` fields `KitSource→InstallKind` | these describe installed/updated stashes — install domain |

### Deliberately left
| Site | Why left |
|---|---|
| `parseRegistryRef` (`resolve.ts:53`) | a string-**prefix** parser (branches on `ref.startsWith("npm:"/"github:"/"git+"/"file:"/"http")` with a `looksLikeGithubOwnerRepo` heuristic fallthrough). It has **no source key** to share with a table — different concern (text→union), confirmed. |
| `parseSourceSpec` (`config-sources.ts:35`) | the **other** (6-member CONFIG) domain. It switches on on-disk `entry.type` (`filesystem\|git\|website\|npm`) and has a semantic `filesystem` repair-fallback `default`. Dragging it into an install table would merge the two proven-distinct unions. |
| `config-schema.ts:531` `KitSourceSchema` z.enum (6 members) | the CONFIG runtime validator; it must keep validating `website`/`filesystem`. Not the install set. |
| `RemoveResponse.removed.source` (`sources/types.ts:226`) | already `KitSource \| string` (widened); a remove-path field, not an install discriminator. Sound as-is. |
| `syncRegistryGitRef` internal `github→git` renormalization (`git-install.ts`) | the materializer's own concern, not a dispatch site. |
| `resolveRegistryArtifact` / `syncFromRef` **not merged into a shared Record** | they are non-isomorphic: `resolveRegistryArtifact` is a 4-way dispatch, `syncFromRef` is a 3-way dispatch (git+github collapsed) with lazy-import boundaries. One Record would duplicate the git handler and erase the code-split. |

---

## 4. Behavior-preservation hazards and how each is handled

1. **`github`/`git` collapse in `syncFromRef`** — PRESERVED. The site is left as `if (source === "git" || source === "github")` → single `await import("./git")` → `syncRegistryGitRef`. Not building a table is precisely what avoids the temptation to split this into two rows. The lazy `import()` boundaries stay in place.
2. **`default → github` in `buildInstallRef`** — PRESERVED. Rewritten as an explicit `case "github"` returning the identical `` `github:${ref}` ``. Because the param is now the closed `InstallKind`, every value the caller can produce (`stash.source` is already the 4-set, static-index.ts:34) maps to the same output. The old code mapped *any* non-`{npm,git,local}` string to `github:`; the only remaining value under `InstallKind` is `github`, so no real input changes branch.
3. **`website`/`filesystem` non-membership** — HANDLED by construction. These never reach the install path: `asSource()` returns `undefined` for them, `parseRegistryRef` never emits them, and `lockfile.ts:126` rejects them. Narrowing the *types* to `InstallKind` changes no runtime path; it only removes typing that permitted values that can never occur.
4. **`resolveRegistryArtifact` github fallthrough** — PRESERVED. If converted to a switch, `github` becomes an explicit arm returning the same `resolveGithubArtifact(parsed)`; if left as if/else, untouched. Either way only the static type of `parsed.source` tightens.
5. **The `(parsed as { source: SourceSpec["type"] })` cast at `sync-from-ref.ts:35`** — its removal is behavior-neutral (the branch was already unreachable for valid input) and eliminates a latent foot-gun that masked the alias mismatch.
6. **Over-wide typing on `Lockfile`/`Resolved`/`SearchHit`** — re-pointing them to `InstallKind` is a pure tightening: §1 Receipt D shows every writer already produces 4-set values, so no construction site breaks.

---

## 5. Why this gates where the prior attempt failed

The prior "**one source-kinds table keyed by `KitSource`**" could not reach `tsc 0`:

- `KitSource` is the **6-member** config union (§1 Receipt C). A `Record<KitSource, Entry>` is therefore **required** to supply `filesystem` and `website` arms — but sites 2/3/4 have **no** `filesystem`/`website` handler. That forces either uncovered keys (tsc error) or fake throw-cells (behavior risk + biome noise).
- Even with dead arms, a `satisfies never` exhaustiveness check over the parser's real **4-member** union mismatches the 6-member key — the exact `TS2322 '"filesystem"... not assignable to "git"|"npm"|"github"|"local"'` reproduced in §1.
- The three dispatch sites are **non-isomorphic** (4 resolvers / 3 sync-handlers with git+github collapsed / 4 install-ref strings with github formerly `default`). No single `Record` fits all three without duplicating entries and inventing arms.

This design sidesteps all of it: it **keys nothing on `KitSource`**. By introducing `InstallKind` (the 4-set) and pointing install dispatch at it, every switch is exhaustive over exactly the literals it handles — a plain `switch` is tsc-checked with **zero dead arms and no `Record`**. Gate-by-gate:
- **tsc 0** — the only type changes are *tightenings* (4-set ⊂ old 6-set), and every construction site already produces 4-set values (Receipt D).
- **biome 0** — no new abstraction/object/flag; the `never` binding is read; deletions (a cast, an import, a duplicated function) only reduce surface.
- **tests green** — no runtime branch changes; `buildInstallRef` outputs and the `git|github` collapse are byte-identical.

---

## 6. Implementation checklist (TDD-executable, smallest proven increments)

Each step is independently behavior-preserving; gate after each.

1. **Add `InstallKind`** to `src/registry/types.ts`: `export type InstallKind = ParsedRegistryRef["source"];`. Run `bunx tsc -p tsconfig.json --noEmit` → expect 0 (purely additive). 
2. **Re-point install-only `.source` fields** in `registry/types.ts` (`RegistryRefBase`, `ResolvedRegistryArtifact`, `InstalledStashEntry`, `RegistrySearchHit`), `integrations/lockfile.ts:33`, `sources/types.ts:151,245` from `KitSource` → `InstallKind`. Fix the `lockfile.ts:12-14` comment to stop claiming `KitSource` is the 4-set. Gate tsc → expect 0 (tightening; Receipt D guarantees no writer breaks). If any site errors, that site is a genuine 6-set holder — leave it on `KitSource` and note it.
3. **Move `buildInstallRef`**: delete `static-index.ts:377-388`; add the exported 4-`case` switch to `resolve.ts` typed `(source: InstallKind, ref: string)`; add the import in `static-index.ts`; narrow `asSource()` return to `InstallKind`. Gate tsc → expect 0. 
4. **Run the registry/install unit suites** (`scripts/test-unit.sh` shards, or the targeted registry/sources specs) → expect green. The behavioral guarantee is `buildInstallRef` outputs unchanged; if a fixture asserts `github:` for an unknown input, that input can no longer be produced under `InstallKind` and the assertion is dead — confirm before touching it.
5. **(Optional) Convert `resolveRegistryArtifact` if/else → exhaustive switch** (no `default`). Gate tsc + tests → expect 0 / green.
6. **`syncFromRef`**: replace the cast-bearing throw with `const _exhaustive: never = parsed;` + plain throw; remove the now-unused `SourceSpec` import. Gate tsc → expect 0 (if `never` errors, a kind is unhandled — that is the check working; ensure all four arms exist first).
7. **Full gate**: `bunx tsc -p tsconfig.json --noEmit` (0), biome/lint (0 warnings), `bun run test` unit + integration (0 failures). Per the project's clean-commit rule, all three must be green before the work is complete.

---

## 7. Honest net-LOC estimate

| Change | Δ LOC |
|---|---|
| `+ export type InstallKind = ...` | +1 |
| Re-point ~7 `.source` field annotations (`KitSource`→`InstallKind`) | ~0 (in-place) |
| Move `buildInstallRef` (delete from static-index, add to resolve) | ~0 net; `default:`→explicit `github` case ≈ +1 |
| `resolveRegistryArtifact` if/else → switch (optional) | ~0 |
| Delete `(parsed as { source: SourceSpec["type"] })` cast + unused `SourceSpec` import in sync-from-ref | −2 to −3 |
| `_exhaustive: never` lines (1–2) | +1 to +2 |
| Fix stale lockfile comment | ~0 |

**Net ≈ −8 to −12 LOC**, slightly negative to flat. The real win is **coupling removed**, not line count: (1) the install discriminator is decoupled from the 6-member config union, killing the latent over-wide typing on every install structure and the cast it forced; (2) `static-index.ts` (a registry *provider*) stops owning install-ref syntax — the registry-ref grammar (`parseRegistryRef` + its inverse `buildInstallRef`) now lives in one file; (3) two dispatchers gain the compile-time exhaustiveness the switches lacked. **No table, no descriptor object, no new dispatch machinery.**
