// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The line of `src/assets/stash-skeleton/README.md` that reaches curate verbatim as a query. */
const STASH_README_LINE = "This is an **AKM stash** — a structured knowledge repository that stores reusable";

/**
 * What the (trimmed) curate input is when it is not a task, else undefined.
 * Harness and tool envelopes (`<task-notification>…`, `<system-reminder>…`,
 * `<cross-session-message …>…`) start with a tag and close one, and the stash
 * README line arrives verbatim; on the retrieval suite neither shape occurs in
 * a real query. Length is not a signal: prompts over 2,000 characters found
 * relevant assets at about the rate of shorter long prompts.
 */
export function nonTaskInput(query: string): string | undefined {
  if (query.startsWith("<") && query.includes("</")) return "a harness or tool envelope";
  if (query === STASH_README_LINE) return "the akm stash README boilerplate";
  return undefined;
}
