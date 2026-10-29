// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The line of `src/assets/stash-skeleton/README.md` that reaches curate verbatim as a query. */
const STASH_README_LINE = "This is an **AKM stash** — a structured knowledge repository that stores reusable";

/** Exact normalized whole-message phrases; added task text must still retrieve. */
const SOCIAL_INPUTS = new Set([
  "thanks",
  "thanks that worked",
  "thank you",
  "thank you that worked",
  "ok",
  "ok sounds good",
  "ok go ahead",
  "ok sounds good go ahead",
  "okay",
  "okay sounds good",
  "okay go ahead",
  "okay sounds good go ahead",
  "hi",
  "hi are you still there",
  "hi ready when you are",
  "hello",
  "hello are you still there",
  "hello ready when you are",
  "hey",
  "hey are you still there",
  "hey ready when you are",
  "good morning",
  "good morning are you still there",
  "good morning ready when you are",
  "good afternoon",
  "good afternoon are you still there",
  "good afternoon ready when you are",
  "good evening",
  "good evening are you still there",
  "good evening ready when you are",
  "yes",
  "yep",
  "y",
  "no",
  "lgtm",
  "ok do it",
  "do it",
  "go ahead",
  "sounds good",
  "looks good",
  "continue",
  "continue please",
  "perfect",
  "nice",
  "cool",
  "thx",
  "thanks so much",
  "great thanks",
  "ok thanks",
  "ok got it",
  "hi there",
  "hello there",
  "hey thanks a lot",
]);

/**
 * What the (trimmed) curate input is when it is not a task, else undefined.
 * Harness and tool envelopes (`<task-notification>…`, `<system-reminder>…`,
 * `<cross-session-message …>…`) start with a tag and close one, and the stash
 * README line arrives verbatim. Only the explicit normalized phrases
 * above are withheld; this is not general conversational intent detection.
 * Length is not a signal: prompts over 2,000 characters found relevant assets
 * at about the rate of shorter long prompts.
 */
export function nonTaskInput(query: string): string | undefined {
  if (query.startsWith("<") && query.includes("</")) return "a harness or tool envelope";
  if (query === STASH_README_LINE) return "the akm stash README boilerplate";
  const conversational = query
    .toLowerCase()
    .replace(/[,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (SOCIAL_INPUTS.has(conversational)) return "an exact conversational phrase";
  return undefined;
}
