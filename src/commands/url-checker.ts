// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { concurrentMap } from "../core/concurrent";
import type { DeadUrl, DeadUrlCoverage } from "../core/improve-types";
import { systemErrorCode } from "../core/system-error";

export type { DeadUrl, DeadUrlCoverage };

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * URLs are checked `URL_CHECK_CONCURRENCY` at a time via {@link concurrentMap}
 * rather than all at once: a knowledge bundle can hold thousands of links, and
 * firing every HEAD request in one `Promise.allSettled` batch is a
 * self-inflicted denial-of-service against whatever host happens to be linked
 * most. Bounding concurrency changes only how fast the check runs, never how
 * much of it happens — every URL still gets checked.
 */
const URL_CHECK_CONCURRENCY = 8;

/**
 * Per-HEAD-request timeout, matching the old `TIMEOUT_MS` the caps this
 * checker replaced used. A dead site rarely refuses cleanly — it hangs — so
 * without this a handful of unresponsive hosts could stall the whole check
 * indefinitely instead of the timed-out URLs simply showing up as dead.
 */
const DEAD_URL_TIMEOUT_MS = 5000;

/**
 * DNS/connection-level codes meaning "this machine could not reach the host
 * right now" — a corporate DNS block, an offline sandbox, a transient blip —
 * as opposed to "the resource is gone". Same grouping `classifyVectorFailure`
 * (indexer/search/db-search.ts) uses for its "connection failed" bucket.
 * These are counted in `coverage.skipped`, never reported as a `DeadUrl`: an
 * indeterminate result is not evidence a link is dead.
 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export interface DeadUrlCheckResult {
  deadUrls: DeadUrl[];
  coverage: DeadUrlCoverage;
}

/** Per-URL outcome before it is folded into `deadUrls`/`coverage.skipped`. */
interface CheckOutcome {
  dead?: DeadUrl;
  skipped?: boolean;
}

/**
 * Check every URL in `entries` and report the ones that are dead.
 *
 * No cap, no per-entry slice, no ceiling option: it checks every URL given, at a bounded
 * concurrency (see {@link URL_CHECK_CONCURRENCY}) so a large bundle does not
 * turn into a request flood, and each request is bounded by
 * {@link DEAD_URL_TIMEOUT_MS} so one unresponsive host cannot stall the rest.
 *
 * A `>=400` response or a timeout surfaces as a `DeadUrl` (a timeout as
 * `status: "timeout"`) rather than being swallowed, so a network problem is
 * visible instead of looking like a clean bill of health. A DNS/connection
 * failure (see {@link NETWORK_ERROR_CODES}) is different: it says the check
 * itself could not run, not that the URL is dead, so it is counted in
 * `coverage.skipped` instead of either `deadUrls` or a silent success. Any
 * other thrown error still reports as `status: "error"`. `coverage.checked`
 * and `coverage.total` are equal only when nothing was skipped this way.
 */
export async function checkDeadUrls(
  _stashDir: string,
  entries: Array<{ ref: string; body: string }>,
): Promise<DeadUrlCheckResult> {
  const urlsToCheck = entries.flatMap((entry) =>
    (entry.body.match(URL_RE) ?? []).map((url) => ({ ref: entry.ref, url })),
  );

  const outcomes = await concurrentMap(
    urlsToCheck,
    async ({ ref, url }): Promise<CheckOutcome> => {
      try {
        const res = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(DEAD_URL_TIMEOUT_MS),
        });
        return res.status >= 400 ? { dead: { ref, url, status: res.status } } : {};
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          return { dead: { ref, url, status: "timeout" } };
        }
        const code = systemErrorCode(err);
        if (code && NETWORK_ERROR_CODES.has(code)) {
          return { skipped: true };
        }
        return { dead: { ref, url, status: "error" } };
      }
    },
    URL_CHECK_CONCURRENCY,
  );

  const deadUrls: DeadUrl[] = [];
  let skipped = 0;
  for (const outcome of outcomes) {
    if (outcome?.dead) deadUrls.push(outcome.dead);
    if (outcome?.skipped) skipped += 1;
  }

  return {
    deadUrls,
    coverage: { checked: urlsToCheck.length - skipped, total: urlsToCheck.length, skipped },
  };
}
