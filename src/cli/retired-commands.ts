// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Replacement hints for command spellings retired by the 0.9 CLI overhaul
 * (hard break — no aliases). Consulted by the unknown-command error path
 * BEFORE the edit-distance did-you-mean: distance-based suggestions are
 * actively misleading for retired spellings (`init` → "did you mean
 * `info`?", `update` → "did you mean `upgrade`?" — the latter replaces the
 * BINARY, not the sources), and an agent following them gets steered into
 * the wrong command instead of the renamed one.
 *
 * Keys are either a bare retired top-level token (`"init"`) or a
 * group-scoped `"<group> <sub>"` pair (`"env set"`). Keep entries one
 * sentence; the migration pointer is appended by the caller.
 */
const RETIRED_COMMAND_HINTS: Record<string, string> = {
  // Top-level verbs absorbed by the `bundle` group.
  init: "`akm init` moved in 0.9 — use `akm bundle create`.",
  add: "`akm add` moved in 0.9 — use `akm bundle add <source>`.",
  list: "`akm list` moved in 0.9 — use `akm bundle list`.",
  remove: "`akm remove` moved in 0.9 — use `akm bundle remove <source>`.",
  update: "`akm update` moved in 0.9 — use `akm bundle update` (to update akm itself, use `akm upgrade`).",

  // Group renamed to the singular.
  tasks: "the `tasks` group was renamed in 0.9 — use `akm task <subcommand>`.",

  // Verbs absorbed by the `proposal` group.
  extract: "`akm extract` moved in 0.9 — use `akm proposal extract`.",
  propose: "`akm propose` moved in 0.9 — use `akm proposal new`.",
  proposals: "`akm proposals` moved in 0.9 — use `akm proposal list`.",
  accept: "`akm accept` moved in 0.9 — use `akm proposal accept <id>`.",
  reject: '`akm reject` moved in 0.9 — use `akm proposal reject <id> --reason "..."`.',
  diff: "`akm diff` moved in 0.9 — use `akm proposal diff <id>`.",
  revert: "`akm revert` moved in 0.9 — use `akm proposal revert <id>`.",
  reflect: "`akm reflect` was folded into 0.9 — use `akm improve <ref>`.",
  distill: "`akm distill` was folded into 0.9 — use `akm improve <ref>`.",

  // Renamed persistence and observability verbs.
  save: "`akm save` moved in 0.9 — use `akm sync`.",
  events: "`akm events` moved in 0.9 — use `akm log`.",

  // Removed observability surfaces.
  history: "`akm history` was removed in 0.9 — use `akm log --ref <ref>` for an asset's event trail.",
  graph:
    "`akm graph` was removed in 0.9 — graph counts appear in `akm health`; refresh extraction with `akm improve --strategy graph-refresh`.",
  lessons: "`akm lessons` was removed in 0.9 — lesson strength is indexed; use `akm search --type lesson`.",
  lesson: "`akm lesson` was removed in 0.9 — lesson strength is indexed; use `akm search --type lesson`.",

  // Relocated guidance / removed asset verbs.
  mv: "`akm mv` was removed in 0.9 — move the file, then run `akm index` and `akm lint` (to carry ranking signal: `bun scripts/rekey-asset-ref.ts <old-ref> <new-ref>`).",

  // Pre-0.9 removals agents still trip over.
  wiki: "the `akm wiki` family was removed in 0.9 — wikis are ordinary knowledge assets; ingest with `akm import <url> --path <subdir>`.",
  backup:
    "`akm backup` was removed in 0.9 — stop writers and archive current config, data, state, and writable bundles with your normal backup tooling.",
  vault:
    "the `akm vault ...` family was removed in 0.9 — use `akm env list`/`akm env create` for a whole `.env` group, or `akm secret set <name>` for a single sensitive value.",

  // Group-scoped retirements.
  "env set": "`akm env set` was removed in 0.9 — edit the `.env` file directly; akm loads it as-is.",
  "env unset": "`akm env unset` was removed in 0.9 — edit the `.env` file directly; akm loads it as-is.",
  "registry search": "`akm registry search` was folded into `akm search --from registry` in 0.9.",
  "registry build-index":
    "`akm registry build-index` moved in 0.9 — maintainers run `bun scripts/build-registry-index.ts`.",
  "workflow template": "`akm workflow template` was folded into `akm workflow create --print` in 0.9.",
  "workflow validate":
    "`akm workflow validate` was folded into `akm lint --type workflows` in 0.9 (add `--fail-on-flagged` for CI gates).",
  "workflow watch": "`akm workflow watch` was removed in 0.9 — use `akm log --run <run-id>`.",
  "workflow start": "`akm workflow start` was removed in 0.9 — use `akm workflow run <ref>`.",
  "workflow next":
    "`akm workflow next` was removed in 0.9 — use `akm workflow status <target>` to inspect or `akm workflow run <target>` to execute.",
  "workflow complete":
    "`akm workflow complete` was removed in 0.9 — `akm workflow run <target>` completes steps automatically; use `akm workflow status <target>` to inspect.",
  "workflow brief":
    "`akm workflow brief` was removed — the external-driver protocol is gone; `akm workflow run <target>` executes the run and `akm workflow status <target>` inspects it.",
  "workflow report":
    "`akm workflow report` was removed — the external-driver protocol is gone; `akm workflow run <target>` dispatches and records units itself.",
  "config show": "`akm config show` was removed in 0.9 — use `akm config list`.",
  "config validate": "`akm config validate` was removed in 0.9 — the config file is validated on every load.",
  "task enable": "`akm task enable` was removed in 0.9 — set `enabled: true` in the task YAML, then `akm task sync`.",
  "task disable":
    "`akm task disable` was removed in 0.9 — set `enabled: false` in the task YAML, then `akm task sync`.",
  "task init": "`akm task init` was removed in 0.9 — `akm setup` seeds the default schedules.",
  "task show": "there is no `task show` — task files are indexed assets; use `akm show <ref>`.",
  "task remove": "there is no `task remove` — delete the task YAML, then run `akm task sync` to unbind it.",
  // `improve canary` is NOT here: `akm improve` is a leaf command (a
  // positional `ref`, not a subcommand group), so "canary" never reaches the
  // unknown-command path this table serves — `improve-cli.ts` already
  // self-diagnoses it with a more specific, correct message before this
  // table would ever be consulted.
  "log tail": "`akm log tail` was removed in 0.9 — poll `akm log --since @offset:<id>` (the durable cursor).",
  "log list": "`akm log list` was flattened in 0.9 — bare `akm log` is the same surface.",
};

const MIGRATION_POINTER = "Full rename table: `akm help migrate 0.9.0`.";

/**
 * Replacement hint for a retired spelling, or undefined when the attempted
 * token isn't a known retirement. `parentPath` is the group path already
 * resolved before the unknown token (empty at root), so `env set` and a
 * hypothetical top-level `set` can't collide.
 */
export function retiredCommandHint(parentPath: readonly string[], attempted: string): string | undefined {
  const key = parentPath.length === 0 ? attempted : `${parentPath[parentPath.length - 1]} ${attempted}`;
  const entry = RETIRED_COMMAND_HINTS[key];
  return entry === undefined ? undefined : `${entry} ${MIGRATION_POINTER}`;
}

/**
 * Same idea as {@link RETIRED_COMMAND_HINTS}, but for FLAGS the 0.9 overhaul
 * removed outright rather than commands. Consulted by
 * `src/cli/unknown-flags.ts` BEFORE its own edit-distance did-you-mean, for
 * the same reason: a distance-based suggestion on a retired flag can point at
 * an unrelated survivor rather than the real replacement procedure.
 *
 * Keys are the FULL resolved command path joined with spaces, plus the flag
 * exactly as the unknown-flag scanner reports it (leading dashes, long form
 * only — `--background`, not `-b`): `"<cmd> [sub...] --flag"`. The command
 * path is whatever `unknown-flags.ts`'s `KnownArgs.path` resolved (e.g.
 * `["proposal", "extract"]` for the flag's CURRENT location, not any retired
 * top-level spelling — that command-level retirement is already handled by
 * {@link retiredCommandHint} before flag scanning ever runs).
 */
const RETIRED_FLAG_HINTS: Record<string, string> = {
  "index --background": "`--background` was removed in 0.9 — the flag never actually backgrounded; use `--quiet`.",
  "setup --detect-only":
    "`--detect-only` was removed in 0.9 — environment detection runs inside `akm setup`; `akm info` reports the configured capabilities.",
  "setup --reset-recommended":
    "`--reset-recommended` was removed in 0.9 — `akm setup` now offers to apply recommended defaults interactively.",
  "proposal extract --watch":
    "`--watch` was removed in 0.9 — schedule `akm proposal extract --auto` as a task instead.",
  "proposal extract --debounce-ms":
    "`--debounce-ms` was removed in 0.9 — schedule `akm proposal extract --auto` as a task instead.",
};

/**
 * Replacement hint for a retired flag on its current command path, or
 * undefined when the attempted spelling isn't a known retirement.
 */
export function retiredFlagHint(path: readonly string[], attempted: string): string | undefined {
  const key = `${path.join(" ")} ${attempted}`;
  const entry = RETIRED_FLAG_HINTS[key];
  return entry === undefined ? undefined : `${entry} ${MIGRATION_POINTER}`;
}
