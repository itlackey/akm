// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-cli/api` — the one supported programmatic entry point. Everything else
 * in this package is CLI-only. See docs/reference/api.md for the contract.
 *
 * Each export runs the same code path as its CLI command and computes the
 * document the CLI would print, in-process: no child process, no write to
 * stdout/stderr, no `process.chdir`, no change to the host's `process.env`,
 * and no process-level output-mode, quiet or verbose state left changed.
 */

import { renderOutput } from "./cli/shared";
import { runCurate } from "./commands/read/search-cli";
import { loadConfig } from "./core/config/config";
import { UsageError } from "./core/errors";
import { withQuiet } from "./core/warn";
import { installLlmUsagePersistenceIfAbsent } from "./llm/usage-persist";
import { resolveOutputMode } from "./output/context";
import { stdoutText } from "./output/stdout";

export interface CurateOptions {
  /** Maximum number of curated results (positive integer; the CLI default is 4). */
  limit?: number;
  /** Asset type filter, same as `--type`. */
  type?: string;
  /** Output format, same as `--format`. Default `"json"`, as in the CLI. */
  format?: "text" | "json";
}

/**
 * Returns exactly the stdout text of
 * `akm --shape agent -q curate <query> [--limit N] [--type T] --format <format>`
 * including its trailing newline. Rejects with the error the CLI
 * would fail with: its message, and its error code on the `code` property.
 */
export async function curate(query: string, options: CurateOptions = {}): Promise<string> {
  const format = options.format ?? "json";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`Invalid value for --format: ${format}. Expected one of: json|text`, "INVALID_FORMAT_VALUE");
  }
  return withQuiet(async () => {
    // Same startup order as the CLI: config first (an invalid config fails
    // the call before anything runs), then the output mode from argv + config.
    const mode = resolveOutputMode(["--shape", "agent", "--format", format], loadConfig().output ?? {});
    const disposeLlmUsageSink = installLlmUsagePersistenceIfAbsent();
    try {
      const curated = await runCurate(
        { query, type: options.type, limit: options.limit === undefined ? undefined : String(options.limit) },
        mode,
      );
      return stdoutText(renderOutput("curate", curated, { ...mode, format }));
    } finally {
      disposeLlmUsageSink();
    }
  });
}
