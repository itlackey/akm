// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Run `attempt` once, then again up to `maxRetries` more times while `failed(result)`. Every try gets the whole limit its own call applies. `attempt` is given its 1-based try number. Returns the last result. */
export async function withRetries<T>(
  maxRetries: number,
  attempt: (tryNumber: number) => Promise<T>,
  failed: (result: T) => boolean,
): Promise<T> {
  let result = await attempt(1);
  for (let retry = 1; retry <= maxRetries && failed(result); retry++) result = await attempt(retry + 1);
  return result;
}

/** `withRetries` for a dispatch result: tries again while it is not `ok`, and reports `attempts` when more than one try ran. */
export function retryDispatch<T extends { ok: boolean }>(
  maxRetries: number,
  dispatch: () => Promise<T>,
): Promise<T | (T & { attempts: number })> {
  return withRetries(
    maxRetries,
    (n) => dispatch().then((dispatched) => (n > 1 ? { ...dispatched, attempts: n } : dispatched)),
    (attempt) => !attempt.ok,
  );
}
