// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Run `attempt` once, then again up to `maxRetries` more times while `failed(result)`. Every try gets the whole limit its own call applies. Returns the last result. */
export async function withRetries<T>(
  maxRetries: number,
  attempt: () => Promise<T>,
  failed: (result: T) => boolean,
): Promise<T> {
  let result = await attempt();
  for (let retry = 0; retry < maxRetries && failed(result); retry++) result = await attempt();
  return result;
}
