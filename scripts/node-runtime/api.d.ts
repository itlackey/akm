// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Hand-written declarations for `akm-cli/api` (the build emits no .d.ts).
// tests/contracts/api-surface.test.ts keeps this file and src/api.ts in step.

export interface CurateOptions {
  /** Maximum number of curated results (positive integer; the CLI default is 4). */
  limit?: number;
  /** Asset type filter, same as `--type`. */
  type?: string;
  /** Output format, same as `--format`. Default `"json"`, as in the CLI. */
  format?: "text" | "json";
  /** The caller's project directory. Accepted; has no effect on curate at this version. */
  cwd?: string;
}

/**
 * Returns exactly the stdout text of
 * `akm --shape agent -q curate <query> [--limit N] [--type T] --format <format>`,
 * including its trailing newline. Rejects with the error the CLI would fail
 * with: its message, and its error code on the `code` property.
 */
export function curate(query: string, options?: CurateOptions): Promise<string>;
