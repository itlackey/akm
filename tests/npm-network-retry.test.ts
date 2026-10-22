// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `withNpmNetworkRetry` (#1227) with a stubbed `CommandRunner` and an
 * injected sleep: no real `npm`, no network, no waiting.
 */

import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../scripts/package-install";
import { withNpmNetworkRetry } from "./_helpers/npm-network-retry";

const COMMAND = ["npm", "install", "--global", "/tmp/akm-cli-0.9.32.tgz"] as const;
const OK = { stdout: "added 1 package", stderr: "" };

/** A runner that throws each queued error in turn, then succeeds. */
function stubRunner(errors: Error[]): { runner: CommandRunner; calls: () => number } {
  let calls = 0;
  const runner: CommandRunner = async () => {
    const error = errors[calls++];
    if (error) throw error;
    return OK;
  };
  return { runner, calls: () => calls };
}

function harness() {
  const slept: number[] = [];
  const logged: string[] = [];
  return {
    slept,
    logged,
    options: {
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      log: (line: string) => logged.push(line),
    },
  };
}

const networkError = (code: string) =>
  new Error(`Command failed (1): "npm" "install"\nnpm error code ${code}\nnpm error network request failed`);

describe("withNpmNetworkRetry", () => {
  test("retries a network-class error, then succeeds", async () => {
    const { runner, calls } = stubRunner([networkError("ETIMEDOUT"), new Error("npm error socket hang up")]);
    const { slept, logged, options } = harness();

    expect(await withNpmNetworkRetry(runner, options)(COMMAND, { cwd: "/tmp" })).toEqual(OK);
    expect(calls()).toBe(3);
    expect(slept).toEqual([2_000, 5_000]);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("ETIMEDOUT");
    expect(logged[0]).toContain("attempt 1/3");
    expect(logged[1]).toContain("socket hang up");
    expect(logged[1]).toContain("attempt 2/3");
  });

  test.each(["ECONNRESET", "ENETUNREACH", "EAI_AGAIN", "ECONNREFUSED"])("treats %s as network-class", async (code) => {
    const { runner, calls } = stubRunner([networkError(code)]);
    const { options } = harness();

    await withNpmNetworkRetry(runner, options)(COMMAND, { cwd: "/tmp" });
    expect(calls()).toBe(2);
  });

  test("rethrows the last error once the attempts are exhausted", async () => {
    const last = networkError("ENETUNREACH");
    const { runner, calls } = stubRunner([networkError("ETIMEDOUT"), networkError("ECONNRESET"), last]);
    const { slept, logged, options } = harness();

    await expect(withNpmNetworkRetry(runner, options)(COMMAND, { cwd: "/tmp" })).rejects.toBe(last);
    expect(calls()).toBe(3);
    expect(slept).toEqual([2_000, 5_000]);
    expect(logged).toHaveLength(2);
  });

  test.each([
    ["a bad tarball", "npm error code EINTEGRITY\nnpm error sha512 integrity checksum failed"],
    [
      "a failing lifecycle script",
      "npm error code 1\nnpm error command failed\nnpm error command sh -c node ./install",
    ],
  ])("throws %s immediately with no retry", async (_label, output) => {
    const failure = new Error(`Command failed (1): "npm" "install"\n${output}`);
    const { runner, calls } = stubRunner([failure]);
    const { slept, logged, options } = harness();

    await expect(withNpmNetworkRetry(runner, options)(COMMAND, { cwd: "/tmp" })).rejects.toBe(failure);
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("passes the command and options through and returns the first success untouched", async () => {
    let seen: { command: readonly string[]; cwd: string } | undefined;
    const runner: CommandRunner = async (command, options) => {
      seen = { command, cwd: options.cwd };
      return OK;
    };
    const { slept, options } = harness();

    expect(await withNpmNetworkRetry(runner, options)(COMMAND, { cwd: "/work" })).toBe(OK);
    expect(seen).toEqual({ command: COMMAND, cwd: "/work" });
    expect(slept).toEqual([]);
  });
});
