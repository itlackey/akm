// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The line of `src/assets/stash-skeleton/README.md` that reaches curate verbatim as a query. */
const STASH_README_LINE = "This is an **AKM stash** — a structured knowledge repository that stores reusable";

/** Whole conversational turns only: a greeting or thanks before a task must still retrieve. */
const SOCIAL_INPUT =
  /^(?:(?:thanks|thank you)(?: that worked)?|(?:ok|okay)(?: sounds good)?(?: go ahead)?|(?:hi|hello|hey|good morning|good afternoon|good evening)(?: are you still there| ready when you are)?)$/;

/**
 * What the (trimmed) curate input is when it is not a task, else undefined.
 * Harness and tool envelopes (`<task-notification>…`, `<system-reminder>…`,
 * `<cross-session-message …>…`) start with a tag and close one, and the stash
 * README line arrives verbatim. Standalone social turns have no task, but a
 * greeting followed by task text must pass through. Length is not a signal:
 * prompts over 2,000 characters found
 * relevant assets at about the rate of shorter long prompts.
 */
export function nonTaskInput(query: string): string | undefined {
  if (query.startsWith("<") && query.includes("</")) return "a harness or tool envelope";
  if (query === STASH_README_LINE) return "the akm stash README boilerplate";
  const conversational = query
    .toLowerCase()
    .replace(/[,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (SOCIAL_INPUT.test(conversational)) return "a standalone greeting or acknowledgment";
  return undefined;
}
