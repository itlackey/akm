# Programmatic APIs

`akm-cli` is a CLI package. The recall programmatic entry point is
`akm-cli/api`, which exists so the akm plugins (OpenCode, Claude Code, ...) can
do their automatic recall in-process instead of starting an `akm` process per
prompt. The separate [`akm-cli/workspace`](#local-workspace-akm-cliworkspace)
namespace supports a trusted local desktop host. Deep imports of
`akm-cli/dist/*` are not an API, and the CLI is still the way to run every
other command.

```ts
import { curate } from "akm-cli/api";

const text = await curate("deploy to prod", { limit: 4, type: "skill", format: "text" });
```

## `curate(query, options?)`

```ts
function curate(
  query: string,
  options?: {
    limit?: number; type?: string; source?: string | string[];
    filters?: Record<string, string | string[]>;
    include?: { quality?: "proposed" | "proposed"[]; type?: string | string[] };
    prefer?: Record<string, string | string[]>;
    belief?: "all" | "current" | "historical";
    format?: "text" | "json";
    cwd?: string; project?: string;
  },
): Promise<string>;
```

- **Result.** Exactly the stdout of
  `akm --detail agent -q curate <query> [--limit N] [--type T] --format <format>`,
  including the trailing newline, computed in-process. `format` defaults to
  `"json"`, as the CLI does. It runs the same code as the command (argument
  validation, search, ranking, shaping and rendering are shared, not copied), so
  the two cannot drift.
- **Recall controls.** `source` is CLI `--from` (local, registry, all, or a named
  bundle; an array of bundle names is a repeated `--from`, searched as one set); `filters` takes any frontmatter key, with the same rule
  as repeated CLI `--filter key=value`: each key takes a value or a list, a list
  matches any of its values (an empty string matches assets without the key), and different keys must all match. `prefer` takes
  the same shape as CLI `--prefer` (any frontmatter key; `""` means "without the key"): matching hits rank slightly higher and
  nothing is dropped or admitted. `belief` defaults to `"current"`, keeping
  unflagged reference knowledge and active/asserted assets. These labels do not
  prove factual truth. Explicit `"all"` and `"historical"` support investigations.
  The policy also applies to derived surfaces, support refs and content reads;
  historical evidence is labelled. Registry catalogs have no local scope/belief
  metadata and stay separate.

  ```ts
  await curate("deploy to prod", { source: "team", filters: { user: "alice" } });
  await curate("investigate the old deployment port", { belief: "historical" });
  ```
- **Include.** `include` relaxes only named default exclusions, like repeatable CLI `--include`: `{ quality: "proposed", type: ["session"] }`. Explicit query, type, source and filters still apply. An explicit `include` replaces the entire project value; `{}` clears it. Invalid keys, quality values, empty values and empty value arrays reject.
- **Project.** `cwd` is the caller's working directory; with no `project`, the
  [configured project](configuration.md#projects) whose path contains it (the
  most specific one) supplies the defaults for `source`, `filters`, `prefer` and `include`
  you leave out. `project` names one instead (`"none"`: no project), and an
  unknown name rejects with `INVALID_FLAG_VALUE`. Without either, it uses the
  process's directory. When a project applies, the result carries a `project`
  field. `cwd` is never used to change the process's directory.
- **Failure.** It rejects with an `Error` whose `message` is the CLI's error
  text and whose `code` is the CLI's error code (`MISSING_REQUIRED_ARGUMENT`,
  `INVALID_FLAG_VALUE`, `INVALID_CONFIG_FILE`, ...) wherever the CLI would have
  failed. An unexpected internal failure rejects with a plain `Error` without a
  `code`.
- **No side effects on the host.** No child process; nothing is written to
  stdout or stderr; `process.chdir` is never called; `process.env` and
  `process.argv` are not modified; the host's quiet and verbose state is
  unchanged afterwards. As with `akm curate`, the call records its usage
  event in `state.db`.
- **Repeated calls.** Config is re-validated against `config.json` on every
  call (its path, size and modification time), so an edit to that file is seen by
  the next call exactly as a separate CLI run would see it. A change only in a file
  its `extends` names is not noticed until the config file itself changes. Database handles are
  opened and closed within each call. The local embedding model and the embedding
  cache are kept for the life of the process, which is what makes a warm call
  cheaper than a CLI run. Overlapping calls are safe. Under Bun the SQLite file
  descriptors of a finished call are released when the garbage collector
  finalizes its statements, so they can briefly outlive the call.

## Loading it

`package.json` `exports` maps `akm-cli/api` to `dist/api.js` under Bun and to
`dist/api-node.mjs` under Node (which registers the loader hook for the
package's embedded `.md`/`.xml` assets before loading `dist/api.js`), with
`dist/api.d.ts` for types. `akm-cli/package.json` and `akm-cli/dist/*` are also
exported, so a plugin can locate the `akm` bin with
`require.resolve("akm-cli/package.json")` and published plugin versions that
deep-import `akm-cli/dist/commands/read/*.js` keep working.

## Stability

Evolving (see [STABILITY.md](../../STABILITY.md)): the export list only grows,
and `curate()`'s parameters and result keep the contract above; the text it
returns is the CLI's agent-shaped output and changes whenever that does.
`tests/contracts/api-surface.test.ts` pins the export list.

## Local workspace (`akm-cli/workspace`)

This experimental namespace is a set of typed application operations for a trusted local host such
as akm Desktop. Each operation owns its policy (writability, revision checks, the write lease,
credential redaction); the host owns transport (authentication, HTTP, status codes). Use it
server-side in a trusted local process, never in a renderer or remote/public service. Configure
HOME/XDG and any AKM directory overrides before importing it.

```ts
import { assets, documents, proposals, CONFLICT_CODES, AkmError } from "akm-cli/workspace";

const found = await assets.search({ q: "deploy", limit: 20 });
const source = await documents.readSource({ ref: "stash//knowledge/runbook" });
await documents.save({ ref: source.ref, content: "...", revision: source.revision });
```

Operations are grouped by capability. Every operation takes one typed input object (unknown fields
are ignored) and returns plain JSON-safe data without a CLI envelope; failures reject with an
`AkmError`.

| Namespace | Operations |
| --- | --- |
| `assets` | `search`, `projectOverview`, `searchMisses`, `show`, `history`, `related`, `improvement`, `bundleFiles` |
| `documents` | `readSource`, `save`, `createKnowledge`, `copy`, `retire` |
| `proposals` | `list`, `get`, `recentChanges`, `accept`, `reject`, `revert`, `reopen`, `acceptMany`, `rejectMany` |
| `bundles` | `list`, `add`, `remove`, `update`, `rename`, `setSettings` |
| `config` | `get`, `change`, `changeProjects`, `saveConnection`, `removeConnection` |
| `feedback` | `record` |
| `setup` | `detect`, `apply` (first-run setup: the library, and the agent programs akm may use; `akm bundle create`, `akm setup --yes --harness`) |
| `sensitive` | `describe`, `readValue`, `save`, `remove` (env files and secrets; only `readValue` returns a value) |
| `activity` | `overview`, `pulse`, `health`, `retrievalTrend`, `improveImpact`, `improveRun`, `taskHistory`, `meta` |

Also exported: `AkmError`, `UsageError`, `NotFoundError`, `ConfigError`, `TransientError`, the
`AkmErrorKind` type, `CONFLICT_CODES`, `scrubUrlCredentials` and `indexWrittenAssets(bundleRoot,
files, {bundleId?})`, which refreshes the index rows for files a host edited inside a bundle itself
(it never rebuilds the index and fails open, returning `false`). No primitive is exported: the
env/secret, lease, write-target and dispatcher functions stay inside the operations.

**Revisions.** A `revision` is the sha256 hex of the raw file bytes, for every single-file asset,
env file and secret. Every confirmed write (`documents.save`, `documents.retire`, `sensitive.save`
over an existing file, `sensitive.remove`) takes the revision the caller last saw, and the check
runs inside the write lease against the bytes the operation then replaces. A retire proposal is
minted only from exactly those bytes.

**Errors.** Errors carry a stable `code`. `CONFLICT_CODES` (`ASSET_CONTENT_CHANGED`,
`PROPOSAL_STALE`, `PROPOSAL_NOT_PENDING`, `ASSET_MUTATION_LEASE_HELD`) mean "reload and decide
again"; a host maps them to one conflict status whatever their `kind`. Otherwise `usage` is a bad
request, `not-found` a missing resource, `config` a refusal the user can address (a read-only
bundle) and `transient` contention. A failure that is not an `AkmError` is an internal error.

**Leases.** Interactive writes wait at most a few seconds for another akm process holding the
asset-mutation lease and then reject with `ASSET_MUTATION_LEASE_HELD`; they never wait the CLI's
ten minutes. The operations that run the CLI as a child (below) are the exception: the child takes
the lease itself, with the CLI's wait. `acceptMany` and `rejectMany` are not atomic: each id is its own decision and every
failed id in the result carries its `code`.

Reads open `index.db` and `state.db` read-only and never create or migrate them. Mutations keep the
write leases, auditing, indexing, Git commits and possible pushes of the CLI. `feedback.record` and
the `bundles` actions `add`, `remove`, `update` and `rename`, and `setup.apply`, run the packaged CLI as a child
process (their validation lives in the command bodies, and `add` and `update` do network and git
work that would block a single-threaded host); ship the complete package including its launcher,
Node wrapper and assets. Under Node the existing invocation resolver finds `dist/cli-node.mjs`
relative to the installed package; no global `akm` is needed. `AKM_LAUNCHER_NODE` names the Node
executable the launcher uses for those children; an Electron host using its executable for Node
children must also set `ELECTRON_RUN_AS_NODE=1` in the child's inherited environment. Never
automatically retry a failed mutation: a child may have changed state before its response failed
(a child that exits zero without its expected result rejects with a plain `Error` whose `code` is
`INVALID_COMMAND_RESPONSE`).

`documents.copy({sourceRef, target?, newName?})` copies an asset to a managed bundle and never
overwrites; `documents.retire` archives one (undo is `proposals.revert` of the returned
`proposalId`). A move is a copy followed by a retire of the original, composed by the host; there
is no transaction across the two.

The [workspace reference](workspace.md) lists what each operation returns and accepts.

The package maps this namespace to `dist/workspace.js` under Bun and
`dist/workspace-node.mjs` under Node. The Node entry registers the existing
embedded-text loader before importing the graph. `dist/workspace.d.ts` is
hand-written (the build emits no declarations; read models are declared `unknown`), copied like `dist/api.d.ts`, and
`tests/contracts/workspace-surface.test.ts` keeps it in step with `src/workspace.ts`; a strict
Node TypeScript consumer of the tarball checks it too. The existing `akm-cli/api` contract is
unchanged.

After `bun run build`, `bun run test:workspace-package` runs
`tests/integration/install/workspace-package.test.ts`, which packs
and extracts the real tarball, reuses only checkout dependencies offline,
and imports the public namespace under genuine Node and Bun. Every fixture
has isolated HOME/XDG/AKM paths before import; it exercises reads, subprocess
creation, conditional save/conflict, feedback/proposal revert, configuration,
env/secret writes, managed clone and manual retire/revert without a live bundle or model endpoint.
Set `AKM_TEST_NODE_BIN` to a real Node >=22 executable if `node` on PATH is
a Bun compatibility shim. The test is skipped unless
`AKM_WORKSPACE_PACKAGE_TESTS=1` (the target sets it); it fails on a missing
build and runs after building in CI.
