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
    limit?: number; type?: string; source?: string;
    filters?: { user?: string; agent?: string; run?: string; channel?: string };
    belief?: "all" | "current" | "historical";
    format?: "text" | "json";
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
  bundle); `filters` uses the same normalized scope keys and exact AND semantics
  as repeated CLI `--filter key=value`. `belief` defaults to `"current"`, keeping
  unflagged reference knowledge and active/asserted assets. These labels do not
  prove factual truth. Explicit `"all"` and `"historical"` support investigations.
  The policy also applies to derived surfaces, support refs and content reads;
  historical evidence is labelled. Registry catalogs have no local scope/belief
  metadata and stay separate.

  ```ts
  await curate("deploy to prod", { source: "team", filters: { user: "alice" } });
  await curate("investigate the old deployment port", { belief: "historical" });
  ```
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
  call (its path, size and modification time), so an edit on disk is seen by
  the next call exactly as a separate CLI run would see it. Database handles are
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

This experimental namespace reuses core implementations instead of introducing
a second storage policy. Use it server-side
in a trusted local process, never in a renderer or remote/public service.
Configure HOME/XDG and any AKM directory overrides before importing it.

```ts
import {
  handleApiRequest, NO_SUCH_ROUTE, matchWorkspaceAction, handleWorkspaceAction,
  matchWriteRoute, handleWriteRequest, classifyWorkspaceError,
  classifyProposalError, scrubUrlCredentials, AkmError, akmClone,
} from "akm-cli/workspace";

const result = await handleApiRequest("/api/search", new URLSearchParams({ q: "deploy", limit: "20" }));
if (result !== NO_SUCH_ROUTE) {
  const envelope = { ok: true, data: scrubUrlCredentials(result) };
}
```

The dispatcher and clone signatures include:

```ts
handleApiRequest(pathname: string, query: URLSearchParams): Promise<unknown>;
matchWorkspaceAction(path: string): WorkspaceAction | null;
handleWorkspaceAction(action: WorkspaceAction, body: unknown): Promise<unknown>;
matchWriteRoute(pathname: string): WriteRoute | null;
handleWriteRequest(route: WriteRoute, body: unknown): Promise<unknown>;
classifyWorkspaceError(error: unknown): ProposalActionError;
classifyProposalError(error: unknown): ProposalActionError;
scrubUrlCredentials(value: unknown): unknown;
akmClone(options: CloneOptions): Promise<CloneResponse>;
```

`WorkspaceAction`, `WriteRoute`, `ProposalActionError`, `CloneOptions`,
`CloneResponse` and `AkmErrorKind` are exported types. `AkmError` is the existing
runtime error base (`kind`, `code`, `message`, `hint()`); classifiers return
`{status, code, message}`. Unknown reads return the exported `NO_SUCH_ROUTE`
symbol; unknown write paths return `null`. Handler failures reject.

The namespace also re-exports the existing configuration and write-target
resolvers; asset path/ref and containment/atomic-file helpers; mutation leases,
write boundaries, indexing and lint; environment/secret write helpers and
marker paths; bundle rename and task synchronization; URL redaction and errors;
and read-only index entry, stored-vector and metadata repository operations.
These are trusted local building blocks, not an authorization layer. Their
generated declarations are authoritative; none of these helpers or supporting
types inherits the evolving recall API's compatibility promise.

The [UI API reference](ui-api.md) is the single source for route parameters,
body validation and response shapes. Dispatchers return the raw `data`, not
the HTTP envelope. They do not authenticate requests or apply the server's
final `scrubUrlCredentials` pass. A host must enforce per-launch authorization,
same-origin writes, method/content-type/body limits and response redaction
before exposing them over HTTP. Browser markdown is untrusted.

Reads retain the UI's read-only behavior, existing search cap and honest
unavailable states. Mutations retain write leases, revision checks, auditing,
indexing, Git commits and possible pushes. Some workspace actions deliberately
spawn the packaged CLI; ship the complete package including its launcher,
Node wrapper and assets. Under Node the existing invocation resolver finds
`dist/cli-node.mjs` relative to the installed package; no global `akm` is needed.
An Electron host using its executable for Node children must establish
`ELECTRON_RUN_AS_NODE=1` in the child's inherited environment before dispatch.
Unlike `curate`, workspace calls make no promise of silent in-process-only
execution. Never automatically retry a failed mutation: a subprocess may have
changed state before its response failed.

`CloneOptions` is `{sourceRef, newName?, target?, force?, dest?}`. `target` is
a configured managed bundle; omission uses normal write-target resolution.
`dest` is the existing unmanaged path escape hatch and cannot accompany
`target`. A desktop copy operation should use a managed target and omit
`force` and `dest`. `CloneResponse` contains `source: {path, registryId?}`,
`destination: {path, ref?}`, `overwritten`, and optional `remoteFetched` metadata.
Clone retains the same writable-target validation and Git/index effects as
the CLI; it is not a move or rename.

The package maps this namespace to `dist/workspace.js` under Bun and
`dist/workspace-node.mjs` under Node. The Node entry registers the existing
embedded-text loader before importing the graph. `dist/workspace.d.ts` is
generated from the implementations and checked by a strict Node TypeScript
consumer of the tarball. The declaration graph is an implementation detail,
not a stable API for deep imports. The existing `akm-cli/api` contract is unchanged.

After `bun run build`, `bun run test:workspace-package` runs
`tests/integration/install/workspace-package.test.ts`, which packs
and extracts the real tarball, reuses only checkout dependencies offline,
and imports the public namespace under genuine Node and Bun. Every fixture
has isolated HOME/XDG/AKM paths before import; it exercises reads, subprocess
creation, conditional save/conflict, feedback/proposal revert, configuration,
managed clone and manual retire/restore without a live bundle or model endpoint.
Set `AKM_TEST_NODE_BIN` to a real Node >=22 executable if `node` on PATH is
a Bun compatibility shim. The test is skipped unless
`AKM_WORKSPACE_PACKAGE_TESTS=1` (the target sets it); it fails on a missing
build and runs after building in CI.
