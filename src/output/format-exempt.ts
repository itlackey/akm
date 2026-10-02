// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Commands whose output is not an envelope, and therefore not formattable (D7).
 *
 * D7 makes all six `--format` values work on every command that renders through
 * `output()`. A small set does not render an envelope at all: they emit a shell
 * script, drive an interactive prompt, hand stdout to a child process, or print
 * a document that IS the payload. Passing `--format` to one of those cannot do
 * anything useful.
 *
 * The point of declaring the set here is that the exemption stops being
 * implicit. Before D7 you discovered it by getting JSON when you asked for
 * Markdown, or an exit 2 when you asked for HTML. Now the list is one grep away,
 * it is documented in `STABILITY.md`, and asking for a format on an exempt
 * command warns instead of silently doing something else.
 *
 * Names are canonical command paths resolved from the Citty tree.
 */

/**
 * Top-level command tokens whose entire surface is format-exempt.
 */
const EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  // Emits shell completion script source for eval.
  "completions",
  // `migrate status`/`apply` used to be exempt here too: `runMigrationTool`
  // (src/commands/migration-tool.ts) spawns the task-only standalone
  // `scripts/akm-migrate.ts` tool, which always emitted its own fixed JSON
  // shape and never consulted `--format`. `src/commands/migrate-cli.ts` now
  // parses that child's final result line and renders it through the normal
  // `output()` pipeline (registered shape: `src/output/shapes/migrate.ts`;
  // text renderer: `src/output/text/migrate.ts`), so both subcommands honour
  // `--format` like any other command and are no longer listed here. Any
  // progress-event lines the child prints during a real `apply` still print
  // verbatim ahead of the formatted result — those are operational logging,
  // not part of the result envelope, the same way a progress spinner would be.
  // Document payload group: bare `help` prints the sectioned overview,
  // `help migrate <version>` prints release notes, and `help agents` prints
  // the embedded CLI-reference guide (`src/output/cli-hints.ts`) — none of
  // the three render a result envelope.
  "help",
  // Embedded agent guide document.
  "hints",
]);

/**
 * `<command> <subcommand>` pairs that are exempt while the rest of the group
 * formats normally.
 */
const EXEMPT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // Child-process passthrough (the env/secret groups otherwise format fine).
  "env run",
  "secret run",
  // B3/B4 (W1-F): a bare absolute filesystem path IS the payload — the
  // documented shell-substitution primitive (`$(akm env path <ref>)`,
  // Docker `_FILE` / `--env-file`) — not a field worth wrapping in an
  // envelope. Wrapping it broke every existing substitution silently: the
  // CLI's default format is `json`, so an un-flagged `akm env path <ref>`
  // (exactly how the substitution is always written) started emitting
  // `{"path":"..."}` instead of the raw path. Unlike `config path`, this
  // command has no `--all`-style multi-field variant, so the whole surface
  // can be exempt without wrongly warning on a real envelope case.
  "env path",
]);

/**
 * True when `--format` cannot meaningfully apply to this invocation.
 *
 * `commandPath` contains canonical Citty command names from the top-level
 * command through the deepest resolved subcommand.
 */
export function isFormatExemptCommand(commandPath: readonly string[]): boolean {
  const command = commandPath[0];
  if (command === undefined) return false;
  return EXEMPT_COMMANDS.has(command) || EXEMPT_SUBCOMMANDS.has(commandPath.join(" "));
}

/** The declared exempt set, for docs generation and tests. */
export function formatExemptSurfaces(): { commands: readonly string[]; subcommands: readonly string[] } {
  return { commands: [...EXEMPT_COMMANDS], subcommands: [...EXEMPT_SUBCOMMANDS] };
}
