// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Retries an npm command whose failure is a transient network error (#1227).
 *
 * The upgrade rehearsal installs real tarballs from the real registry, and
 * `onnxruntime-node`'s install script downloads its binary from a CDN. One
 * attempt failed the CI job on any blip. `runCommand` throws an `Error` whose
 * message carries the command's stdout and stderr, so that text is what this
 * matches. Any other failure (a bad tarball, a failing lifecycle script) is
 * rethrown on the first attempt.
 *
 * Test-only: the shipped CLI install path does not retry.
 */

import type { CommandRunner } from "../../scripts/package-install";

const NETWORK_ERROR = /\b(ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN|ECONNREFUSED)\b|socket hang up/;

/** Waits between attempts: two retries, so three attempts in all. */
const DEFAULT_DELAYS_MS = [2_000, 5_000] as const;

export interface NetworkRetryOptions {
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

export function withNpmNetworkRetry(runner: CommandRunner, options: NetworkRetryOptions = {}): CommandRunner {
  const delaysMs = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = options.log ?? ((line: string) => console.error(line));
  const attempts = delaysMs.length + 1;

  return async (command, runOptions) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await runner(command, runOptions);
      } catch (error) {
        const match = NETWORK_ERROR.exec(error instanceof Error ? error.message : String(error));
        if (!match || attempt >= attempts) throw error;
        const delay = delaysMs[attempt - 1] as number;
        log(
          `npm network error (${match[0]}) on attempt ${attempt}/${attempts}; retrying in ${delay}ms: ${command.join(" ")}`,
        );
        await sleep(delay);
      }
    }
  };
}
