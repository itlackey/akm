// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export interface DeadUrl {
  ref: string;
  url: string;
  status: number | "timeout" | "error";
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const TIMEOUT_MS = 5000;
const MAX_URLS = 20;

export async function checkDeadUrls(
  _stashDir: string,
  entries: Array<{ ref: string; body: string }>,
): Promise<DeadUrl[]> {
  const urlsToCheck: Array<{ ref: string; url: string }> = [];

  for (const entry of entries) {
    if (urlsToCheck.length >= MAX_URLS) break;
    const matches = entry.body.match(URL_RE) ?? [];
    for (const url of matches.slice(0, 3)) {
      urlsToCheck.push({ ref: entry.ref, url });
      if (urlsToCheck.length >= MAX_URLS) break;
    }
  }

  const results: DeadUrl[] = [];
  await Promise.allSettled(
    urlsToCheck.map(async ({ ref, url }) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timer);
        if (res.status >= 400) {
          results.push({ ref, url, status: res.status });
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          results.push({ ref, url, status: "timeout" });
        }
        // network errors (ENOTFOUND etc.) — skip, don't report as dead
      }
    }),
  );

  return results;
}
