# Adapters

A **`BundleAdapter`** (`src/core/adapter/bundle-adapter.ts`) is the code that
decides what a bundle's files *are*, how they're indexed, how `akm lint`
validates them, and where a new item would be placed. 0.9.0 ships 11
built-in adapters — one per format in
[Supported Formats](../reference/supported-formats.md). This page is the
write-path and internals reference; that page is the compatibility table.

For read-only native tool bundles, recognition is runtime translation, not
conversion: the adapter projects native files into AKM's index/runtime shapes
while the source file remains authoritative. AKM does not synchronize native
formats, maintain translated canonical copies, or write agent/command assets
back through the Claude/OpenCode adapters. See
[Agent, Command, Engine, and Model Resolution](specs/agent-command-engine-model-design.md).

> **Stability note.** The adapter set, bundle-recognition rules, and the
> `bundles` config shape are still evolving — see [STABILITY.md](../../STABILITY.md).

---

## Probe order

Each bundle root is owned by exactly **one** adapter, decided once at
install/index time:

1. If the bundle's config entry sets `components.<id>.adapter` explicitly,
   that adapter wins — no detection runs.
2. Otherwise, every built-in adapter's `looksLikeRoot(root)` probe runs in a
   **fixed order**, most-specific markers first. The first probe that
   returns `true` claims the root.
3. If no probe fires, the bundle falls back to the `akm` adapter.

The order is pinned by `BUILTIN_ADAPTERS` (`src/core/adapter/adapters/index.ts`)
and enforced by the conformance suite's ordered-owner matrix — it, not any
prose spec listing, is authoritative:

```text
website-snapshot   -- root manifest.json {url, fetchedAt}
agent-skills       -- a <name>/SKILL.md package at the bundle root
claude             -- root CLAUDE.md + commands/|agents/|skills/
opencode           -- opencode.json(c), or root AGENTS.md + a tool dir
dotenv             -- every top-level dir is env/ and/or secrets/
akm-workflow       -- a top-level .md with explicit type: workflow
akm-task           -- a top-level valid task source v4 .yml (schedule optional)
llm-wiki           -- root schema.md + pages/
akm                -- .stash marker, or 2+ native subdirs, or fallback
okf                -- root index.md, or any .md with frontmatter type
generic-files      -- never auto-selected; explicit config only
```

The rationale for the ordering:

- The three loosest probes — `llm-wiki`, `akm`, and `okf` — stay **last**.
  Native AKM evidence wins before OKF because AKM Markdown is an OKF
  superset; the `akm` probe is strict enough not to claim an OKF bundle
  merely because it contains one familiar directory name.
- `akm.looksLikeRoot` fires on any root carrying a bundle-subdir-named
  directory — which includes a `.claude`/`.opencode` tool dir (`commands/`,
  `agents/`, `skills/`) and a dotenv bundle (`env/`, `secrets/`). So
  `claude`/`opencode`/`dotenv` come **ahead of** `akm`; their tighter markers
  claim those roots first, and `akm` still wins its own workspace root
  (which those tighter probes reject).
- `website-snapshot`, `agent-skills`, `akm-workflow`, and `akm-task` carry
  disjoint, specific markers that fire on none of the other roots, so they
  sit at the front for clarity.
- `generic-files` is explicit-config-only — its `looksLikeRoot` never fires —
  so it's last and can never shadow anything.

---

## `BundleAdapter` interface contract

Transcribed from `src/core/adapter/bundle-adapter.ts`:

```ts
interface BundleAdapter {
  readonly id: string;
  readonly version: string;              // feeds incrementality + fingerprints
  readonly extensions: readonly string[]; // longest-match stripping + collision priority

  // REQUIRED — single-file recognition primitive.
  recognize(c: BundleComponent, file: FileContext): IndexDocument | null;

  // OPTIONAL — full-component scan for non-per-file layouts (website
  // snapshots, llm-wiki multi-file semantics). Absent -> the core walk
  // (git-aware, symlink-safe, skip-dirs) drives recognize() per file.
  index?(inst: BundleInstallation, c: BundleComponent): AsyncIterable<IndexDocument>;

  // OPTIONAL — item-scoped incrementality. Default: identity (one file = one item).
  affectedItems?(c: BundleComponent, changedPaths: string[]): string[];

  // REQUIRED — native validation (change-transaction pre-commit + lint --fix).
  // Adapters MUST NOT write and MUST NOT read the live filesystem: ctx serves
  // a run snapshot with pending changes overlaid, plus a read-only
  // resolveRef for link/xref existence.
  validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

  // OPTIONAL — the CLOSED-FORM set of existing-file placements/read aliases
  // that could own `conceptId`, used for first-owner arbitration without
  // reading authored bytes or walking the bundle.
  readCandidates?(c: BundleComponent, conceptId: string): Array<{ path: string; conceptId: string }>;

  // OPTIONAL — discovery.
  directoryList?(c: BundleComponent): string[];               // owned dirs; feeds git exact-path staging
  looksLikeRoot?(root: string): boolean;                      // install-time probe
}
```

`recognize` and `validate` are required on every adapter; `index`,
`affectedItems`, `readCandidates`, `directoryList`, and
`looksLikeRoot` are optional capability methods. An adapter overriding `index()` must keep
`recognize()` coherent with it (conformance: `index()` == fold of
`recognize()` over the core walk) or declare component-level
incrementality.

`readCandidates` is intentionally distinct from `extensions`: extensions are
non-exhaustive walk hints. Read candidates preserve canonical directory
manifests (for example `skills/<name>/SKILL.md`) so lookup, index-backed show, and workflow runtime share one
physical-owner decision. Each candidate carries its canonical concept identity,
so a byte-denying ownership probe never has to infer identity from the query.
Path-derived recognition (`toCanonicalName`/`toAssetPath`, `src/core/asset/asset-placement.ts`)
is a deterministic function of a file's path, so its inverse — every physical
spelling that could own one conceptId — is computable in CLOSED FORM (#857):
the canonical placement under the type's own bundle subdir, the loose
off-canonical placement (an authored path elsewhere in the bundle, keyed off
its full path relative to the bundle root instead of the type subdir — this
is what `readCandidates` returns for it), and any type-specific duality (for
example `env`'s `.env`/`<name>.env` spellings for the "default" alias).
`readCandidates` enumerates the complete closed-form set directly from the
conceptId; no bundle walk is needed, so no scan bound applies. The shared
authority (`src/indexer/lookup/adapter-concept-owner.ts`) still probes every
candidate with a byte-denying `FileContext` before trusting it, so an
adapter returning a candidate the file does not actually own is harmless —
it is simply filtered out.

The core walk — the live indexer's per-dir walk, drained by
`drainDirDocuments` — is one implementation carrying the security policy
(symlink-safety, skip-dirs, git-awareness); adapters never reimplement it.

Cross-component ref existence is a **core** base check, not an adapter
concern.

---

## Placement

Adapters do not place new items. AKM-native writes resolve through AKM's own
flat type→directory placement table (`src/core/asset/asset-placement.ts`'s
`PLACEMENT_SPECS`), which is correct for akm-layout bundles — the only bundles
the write commands touch in practice. A per-adapter `placeNew()` existed
through 0.9 but nothing called it, and it was removed in 0.10. Supporting
writable bundles in another layout would need it back: see
[#1163](https://github.com/itlackey/akm/issues/1163).

---

## Write allowlists

Which bundles AKM-native write commands are allowed to touch at all is decided by a
small allowlist check, `assertAkmAssetWrite` (`src/core/write-source.ts`),
run before any write command touches the filesystem. It compares the target
bundle's detected (or configured) adapter id against an allowlist and throws
a `UsageError` on a miss.

The default allowlist is `["akm"]`. Two command families widen it explicitly:

| Command | Allowlist adds |
| --- | --- |
| `akm env create` / `env remove` / `secret set` | `dotenv` |
| `akm workflow create` | `akm-workflow` |

Every other adapter (`agent-skills`, `claude`, `opencode`, `akm-task`,
`generic-files`, and so on) is rejected by every AKM-native write command.
`akm task add` in particular uses the *default* allowlist (`akm` only), so a
standalone `akm-task` bundle is read-only through AKM-native write commands.

Reading, searching, and `akm lint` are unaffected by this allowlist — only
creating, editing, or deleting through AKM's own commands is restricted.
"Read-only" in [Supported Formats](../reference/supported-formats.md) means
this write-command restriction, not a filesystem permission.

This allowlist boundary is also where AKM's [execution
boundary](../guides/concepts.md) principle shows up on the write side: AKM
retrieves and validates every supported format, but it only lets its own
write commands mutate a narrow, explicitly-declared set of targets — it
does not widen write access to a format just because it can read it.

---

## Task adapter

The native and standalone `akm-task` paths delegate to the authoritative task
source parser, `parseTaskSource`, which accepts only `version: 4` (task
source v4). A task source v4 document declares exactly one executable
selector (`uses` or `run`), but its scheduling is OPTIONAL — a document with
no `schedule:` is valid and runnable manually. A `version: 3` or `version: 2`
document is no longer read by `src` at all: it fails closed with
`TASK_SCHEMA_VERSION_UNSUPPORTED`, naming `akm migrate` as the path forward.
See [Tasks](../reference/tasks.md) for the public source contract and the
migration path.

---

## Implementation caveats

A few adapter-specific behaviors are easy to assume differently from how
they actually work:

- **`agent-skills` recognition/validation are decoupled.** The per-change
  half of `validate()` only inspects changes that resolve to an actual
  `SKILL.md`, so an invalid skill is still indexed as `skill` (with its raw,
  invalid name projected) and its field violations surface only for files
  that exist. `missing-skill-md` is the exception and runs as a separate
  directory pass over `ValidateContext.list`: a **top-level** directory that
  holds files but no `SKILL.md` anywhere within three levels is flagged. A
  package's own resource dirs (`pdf-processing/reference/`) are part of the
  item, not candidate packages, and are never considered.
- **`claude`/`opencode` share one codec** (`tool-dir-shared.ts`) and differ
  only in instruction filename and adapter/component ids. Both accept only
  the canonical plural tool directories.
- **`dotenv` redaction is a hard, adapter-level contract.** No frontmatter
  `type:` override can bypass it: `env` entries surface only key names,
  `secret` entries surface only the file name, never content. A `.env`
  file placed under `secrets/` is a secret (name-only), not an env group —
  the directory gate wins over the `.env` suffix.
- **Task adapters share one task source parser.** A standalone `akm-task`
  bundle and task files owned by the native `akm` adapter both route through
  `parseTaskSource`, which accepts only `version: 4` (task source v4) — a
  `version: 3` or `version: 2` document fails closed with
  `TASK_SCHEMA_VERSION_UNSUPPORTED` and is never indexed, validated, or run.
  Task source v4 requires exactly one `uses` or `run` executable selector,
  but its `schedule:` is OPTIONAL. It recognizes `akm/command`, `commands/`,
  `workflows/`, and `scripts/` targets, refuses the github-action `uses:`
  variant entirely (removed in v4 — no equivalent spelling), and refuses
  agent/task refs and unsupported actions. `.yaml` is a collection hint only:
  recognition still gates on `.yml`, so the near miss is diagnosed but never
  indexed or scheduled. See the [Tasks reference](../reference/tasks.md).
- **`llm-wiki`, `akm`, and `okf` all reserve `index.md`/`log.md`** as
  structural files — never indexed as concepts, never valid write targets —
  at any depth.
- **`okf`'s lenient wording is not a lenient gate.** `missing-type` and
  broken-link findings are labelled `info:`/`warning:` in the diagnostic
  text, but diagnostics carry no severity field: `akm lint` funnels every
  finding into one `flagged` list, and `--fail-on-flagged` fails on any
  non-empty list.
- **`generic-files` is the only adapter with no auto-detection at all.**
  `looksLikeRoot` always returns `false`; a bundle only gets this adapter
  through an explicit `components.<id>.adapter: "generic-files"` override.

---

## See also

- [Supported Formats](../reference/supported-formats.md) — the compatibility table this page's internals back
- [Asset Types](../reference/asset-types.md) — the `akm` adapter's 14 native asset types
- [Concepts](../guides/concepts.md) — the retrieval loop and execution boundary these adapters serve
- [Architecture](architecture.md) — sources, refs, the search pipeline, and the write-source chokepoint
