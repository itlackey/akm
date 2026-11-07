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
  /** Named bundle or local|registry|all, same as --from; an array of bundle names is a repeated --from (searched as one set). */
  source?: string | string[];
  /** Exact scope values, same as repeated --filter: a list matches any of its values; different keys must all match. An empty string matches assets without the key. */
  filters?: { user?: string | string[]; agent?: string | string[]; run?: string | string[]; channel?: string | string[] };
  /** Default current; labels do not establish factual truth. */
  belief?: "all" | "current" | "historical";
  /** Output format, same as `--format`. Default `"json"`, as in the CLI. */
  format?: "text" | "json";
  /** The caller's working directory; it selects a configured project (default: the process's). */
  cwd?: string;
  /** A configured project to use instead of the one `cwd` selects, same as `--project`; `none` uses no project. */
  project?: string;
}

/**
 * Returns exactly the stdout text of
 * `akm --detail agent -q curate <query> [--limit N] [--type T] --format <format>`,
 * including its trailing newline. Rejects with the error the CLI would fail
 * with: its message, and its error code on the `code` property.
 */
export function curate(query: string, options?: CurateOptions): Promise<string>;
