# Programmatic API (`akm-cli/api`)

`akm-cli` is a CLI package. The one supported programmatic entry point is
`akm-cli/api`, which exists so the akm plugins (OpenCode, Claude Code, ...) can
do their automatic recall in-process instead of starting an `akm` process per
prompt. Everything else in the package stays CLI-only: deep imports of
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
  options?: { limit?: number; type?: string; format?: "text" | "json" },
): Promise<string>;
```

- **Result.** Exactly the stdout of
  `akm --detail agent -q curate <query> [--limit N] [--type T] --format <format>`,
  including the trailing newline, computed in-process. `format` defaults to
  `"json"`, as the CLI does. It runs the same code as the command (argument
  validation, search, ranking, shaping and rendering are shared, not copied), so
  the two cannot drift.
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
