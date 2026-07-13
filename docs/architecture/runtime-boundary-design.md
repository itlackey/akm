# Runtime Boundary Design — AKM 0.9.0

## Problem

Runtime-specific dependencies (`bun:sqlite`, `Bun.*` APIs) leak directly into 33+ source files.
This creates unnecessary coupling, makes Node.js compatibility hard, and means every future
runtime change has a large blast radius.

## Goal

Two files own the entire runtime boundary. Everything else is clean application code.

---

## File 1: `src/storage/database.ts`

Single source of truth for SQLite. The rest of the app never imports from `bun:sqlite` or
`better-sqlite3` directly — only from here.

**Responsibilities:**
- Detect runtime (bun vs node) once at module load
- Load the appropriate SQLite driver (`bun:sqlite` on Bun, `better-sqlite3` on Node)
- Export `Database` type — the common structural type both drivers share
- Export `openDatabase(path, opts?)` factory

**Design constraints:**
- No adapter classes, no interface hierarchies — the driver APIs are already nearly identical
- The exported `Database` type should be the structural intersection of what both drivers expose
- `openDatabase()` should be a simple function, not a factory class
- `db.query()` (Bun-specific) must be normalised — replace with `db.prepare().all()` at this boundary

**Architect: investigate and fill in:**
- [ ] Read `src/indexer/db.ts`, `src/core/state-db.ts`, `src/workflows/db.ts` — the 3 hard-import files
- [ ] Identify every method AKM actually calls on a `Database` instance (exec, prepare, transaction, close, query, etc.)
- [ ] Check whether `better-sqlite3`'s type definitions can be used as the exported `Database` type directly, or if a small structural type alias is needed
- [ ] Check `sqliteVec.load(db)` — confirm whether it accepts both driver handles or needs a raw handle escape hatch
- [ ] Write the complete file

---

## File 2: `src/runtime.ts`

~60 lines. Named exports for every `Bun.*` API called outside of the SQLite layer.
Each export works on both runtimes.

**Known Bun.* call sites to cover (architect: verify these are complete):**

| Export name | Bun API | Node equivalent |
|---|---|---|
| `spawnSync(cmd, opts)` | `Bun.spawnSync` | `child_process.spawnSync` |
| `spawn(cmd, opts)` | `Bun.spawn` | `child_process.spawn` |
| `readStdin(limitBytes)` | `Bun.stdin.stream()` | `for await (chunk of process.stdin)` |
| `writeResponseToFile(path, res)` | `Bun.write(path, response)` | `stream/promises pipeline` |
| `sha256Hex(data)` | `new Bun.CryptoHasher('sha256')` | `node:crypto createHash` |
| `md5Hex(data)` | `new Bun.CryptoHasher('md5')` | `node:crypto createHash` |
| `semverOrder(a, b)` | `Bun.semver.order` | `semver.compare` (add dep) |
| `getDirname(importMetaUrl)` | `import.meta.dir` | `path.dirname(new URL(url).pathname)` |
| `resolveModule(spec, from)` | `Bun.resolveSync` | `require.resolve` (already has fallback) |
| `sleepSync(ms)` | `Bun.sleepSync` | `Atomics.wait` (already has fallback) |
| `mainPath` | `Bun.main` | `process.argv[1]` |

**Design constraints:**
- Runtime detection: `const isBun = !!process.versions?.bun` at top of file, used inline
- No class, no factory — just named function exports
- Each export branches once on `isBun`, no per-call overhead
- `node:crypto` is available in both Bun and Node — the crypto exports can skip the `isBun`
  branch entirely and just use `createHash` always (simpler, same perf for a CLI)

**Architect: investigate and fill in:**
- [ ] `grep -rn "Bun\." src --include="*.ts"` — confirm the table above is complete
- [ ] `grep -rn "import\.meta\.dir" src --include="*.ts"` — list all sites, note which have fallbacks
- [ ] Confirm `Readable.toWeb()` is the right Node 18 approach for `writeResponseToFile`
- [ ] Write the complete file

---

## Call Site Changes

Once both files exist, the remaining work is mechanical:

**SQLite type-only imports (~30 files):**
```ts
// Before
import type { Database } from 'bun:sqlite'
// After
import type { Database } from '../storage/database'
```

**SQLite hard imports (3 files — `indexer/db.ts`, `core/state-db.ts`, `workflows/db.ts`):**
- Replace `import { Database } from 'bun:sqlite'` with `import { openDatabase, type Database } from '../storage/database'`
- Replace `new Database(path)` with `openDatabase(path)`
- Replace `db.query<T>(sql).all(params)` with `db.prepare(sql).all(params)` (Bun-specific API)
- Remove `SQLQueryBindings` spread casts

**Bun.* call sites (~10 files):**
```ts
// Before
Bun.spawnSync(['git', 'ls-files', ...])
// After
import { spawnSync } from '../runtime'
spawnSync(['git', 'ls-files', ...])
```

**Architect: investigate and fill in:**
- [ ] List every call site file and the exact import line change needed
- [ ] Flag any call site where the shim return shape differs from the Bun API (e.g. stdout as string vs Buffer)

---

## `package.json` Changes

- Add `better-sqlite3` as `optionalDependency` (prebuilt binaries, no compile step on common platforms)
- Add `@types/better-sqlite3` to `devDependencies`
- Add `semver` to `dependencies` (tiny, zero-deps)
- Add `node: ">=20.12.0"` to `engines` (`@clack/core` uses `node:util.styleText`,
  which was added in Node 20.12)
- Require Node >= 20.12 in the npm `preinstall` guard

---

## What This Is NOT

- Not an adapter pattern with interface hierarchies
- Not a ports-and-adapters architecture
- Not a plugin system
- Not a DI container

Just two modules that own the runtime details so the rest of the codebase doesn't have to.

---

## Child Issues to Create (after design is complete)

1. `src/storage/database.ts` + migrate 3 hard-import files
2. Mechanical: update 30 type-only imports (sed pass + tsc verify)
3. `src/runtime.ts` + update ~10 call sites
4. `package.json` + relax preinstall guard + CI Node matrix

Plus: audit open GitHub issues on itlackey/akm and close any that are superseded by this work
or otherwise stale (milestone 0.9.0 items already addressed, etc.).
