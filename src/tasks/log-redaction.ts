// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Decide which exact values must be scrubbed from a task's persisted run log
 * (issue #755).
 *
 * # The gap
 *
 * All three task target kinds funnel through `persistRunLog`, which applied
 * only `redactCredentialPatterns` — credential *shapes* (`Bearer …`, `sk-…`,
 * webhook URLs). Prompt- and workflow-target runs additionally redact the exact
 * secret values reachable by the run before their output ever reaches the log.
 * Command-target runs did not: a scheduled command that echoed a configured
 * secret whose value is not credential-shaped persisted it verbatim, into both
 * the `.log` file and `logs.db`, for the whole retention window.
 *
 * # Why the obvious fix is wrong
 *
 * The issue proposed reusing {@link isEnvPassthroughValueSafeToExpose} — the
 * filter the prompt path uses — over the env handed to the child. That filter
 * fails CLOSED for any name outside a 22-entry allowlist, which is right where
 * it currently runs: the prompt path filters `envPassthrough`, a short list the
 * operator explicitly declared. A command task inherits the WHOLE ambient
 * environment, so the same rule classifies essentially everything as secret.
 * Measured on a developer machine: 127 of 132 variables, 25 of them with
 * one-character values (`SHLVL=1`, `OLDPWD=/`, `GIT_TERMINAL_PROMPT=0`).
 * Redaction is substring replacement, so those become live needles:
 *
 *     Build finished in 12.4s        ->  Build finished in [REDACTED]2.[REDACTED]s
 *     3 tests passed, 0 failed       ->  [REDACTED] tests passed, [REDACTED] failed
 *     wrote dist/index.js (48 KB)    ->  wrote dist[REDACTED]index.js ([REDACTED]8 KB)
 *
 * A fix that destroys every command log is not a fix.
 *
 * # What this does instead
 *
 * Three sources, and the distinction between them is the whole design:
 *
 *  1. **Declared by config** — the config names which variables hold
 *     credentials (a connection's `apiKey: $VAR`, `embedding.apiKey`, the
 *     reranker's) and which keys sit in `credentials.json`. akm KNOWS these
 *     are secret.
 *  2. **Declared by the task** — the `redact:` list, names only.
 *  3. **Inferred** — a name-shape heuristic over the remaining environment, for
 *     the ambient credential akm was never told about.
 *
 * Only (3) is a guess, so only (3) carries {@link MIN_INFERRED_SECRET_LENGTH}.
 * A declared secret is redacted at ANY length, because the operator told us
 * what it is; applying a floor to declared values would silently stop redacting
 * short secrets that are scrubbed today. The floor exists solely to stop a
 * *guess* from mangling a log, and 8 clears every real credential format (AWS
 * key id 20, GitHub PAT 40, `sk-…` 40+) while excluding the flags and counters
 * that a name heuristic occasionally catches.
 *
 * Note what is deliberately NOT collected: the akm secret store on disk. A
 * spawned command sees `process.env`, not akm's stores — a stored secret can
 * only be echoed if it is already in the environment, where the rules above
 * catch it by name. Walking every bundle's `secrets/` on each task firing would
 * cost a recursive readdir plus an unbounded read for values the child cannot
 * reach anyway. `redact:` is the escape hatch for a secret injected under a
 * name none of the rules recognise.
 */

import type { AkmConfig } from "../core/config/config-types";
import { collectCredentialValues } from "../core/config/credentials";
import { collectSensitiveValues, isEnvPassthroughValueSafeToExpose } from "../core/redaction";

/**
 * Shortest value an INFERRED (name-heuristic) match may contribute as a
 * redaction needle. Declared secrets bypass this entirely.
 *
 * Redaction replaces substrings, so a short needle is not merely useless — it
 * corrupts unrelated output. Below 8 the noise tier is fully intact (`1`, `0`,
 * `/`, `80`, `true`, `xhigh`, `31999`); at 8 a chance collision with ordinary
 * log vocabulary is negligible, and every credential format in real use is far
 * longer. It also matches the conventional minimum password length, so a
 * secret shorter than this is already outside normal policy.
 */
export const MIN_INFERRED_SECRET_LENGTH = 8;

/**
 * Environment names whose VALUE is treated as a credential on shape alone.
 *
 * The keyword must be a whole `_`-delimited word. Anchoring on only one side
 * would drag in ordinary configuration from whichever side is left open:
 * a leading anchor alone matches `KEYBOARD_LAYOUT` and `AUTHOR`, a trailing one
 * matches `MONKEY` and `BYPASS`. Whole-word matching gets `GH_TOKEN`,
 * `NPM_AUTH_TOKEN`, `MY_API_KEY`, `DB_PASS` and `AWS_SECRET_ACCESS_KEY` right.
 */
const INFERRED_SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH)(?:_|$)/i;

/**
 * Credential variables whose name is a single glued word, which no
 * word-boundary rule can see. Enumerated rather than matched: loosening the
 * pattern enough to catch `PGPASSWORD` also catches `MONKEY`.
 *
 * `PWD` cannot be a keyword above for the same reason it appears here as part
 * of `MYSQL_PWD` — on its own it is the working directory.
 */
const KNOWN_SECRET_NAMES = new Set(["PGPASSWORD", "MYSQL_PWD"]);

/** True when the NAME alone marks this variable as holding a credential. */
export function isInferredSecretName(name: string): boolean {
  return KNOWN_SECRET_NAMES.has(name.toUpperCase()) || INFERRED_SECRET_NAME.test(name);
}

/** The config this module reads: the blocks that hold an `apiKey`. */
export type TaskLogRedactionConfig = Pick<AkmConfig, "connections" | "embedding" | "search">;

/**
 * Every value that must be scrubbed from one task's persisted output.
 *
 * `declaredNames` comes from the task's `redact:` list. A name that is unset in
 * `env` simply contributes nothing — naming a variable you do not currently
 * export is not an error.
 */
export function collectTaskLogSensitiveValues(input: {
  env: NodeJS.ProcessEnv;
  config?: TaskLogRedactionConfig | undefined;
  declaredNames?: readonly string[] | undefined;
}): string[] {
  const { env, config, declaredNames } = input;
  const values = new Set<string>();
  const addDeclared = (value: string | undefined): void => {
    if (value === undefined) return;
    const trimmed = value.trim();
    // Both spellings: `resolveSecret` does not trim but `resolveCredentialFromEnv`
    // does, so a variable with trailing whitespace reaches an output boundary in
    // either form depending on which path materialized it.
    if (value.length > 0) values.add(value);
    if (trimmed.length > 0) values.add(trimmed);
  };

  // (1) Declared by config — every key a connection, the embedder or the reranker can resolve.
  if (config) {
    for (const value of collectCredentialValues(config, env)) values.add(value);
  }

  // (2) Declared by the task's `redact:` list — names only, never values.
  for (const name of declaredNames ?? []) addDeclared(env[name]);

  // (3) Inferred from the name shape. The only guessing tier, so the only one
  // with a length floor — and still subject to the value-level check that keeps
  // an allowlisted name from being treated as secret.
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_INFERRED_SECRET_LENGTH) continue;
    if (!isInferredSecretName(name)) continue;
    if (isEnvPassthroughValueSafeToExpose(name, value)) continue;
    values.add(value);
  }

  // Expands credential-bearing URLs into their embedded components. Can yield
  // needles shorter than the floor (a URL's password), which is correct: the
  // operator's own value implied them.
  return collectSensitiveValues(values);
}
