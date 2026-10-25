// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Improve's cascade picks where model work runs, farther to nearer:
 * `improve.connection` / `improve.harness`, then `index.<pass>`, then the
 * process, then the current invocation. The nearest layer that names a
 * connection or harness decides, whichever of the two keys each layer used.
 */

import { describe, expect, test } from "bun:test";
import { resolveImproveExecution } from "../../../src/commands/improve/execution";
import type { AkmConfig } from "../../../src/core/config/config";

const config = (improve: Record<string, unknown> = {}): AkmConfig =>
  ({
    configVersion: "0.9.0",
    connections: {
      default: { endpoint: "http://lab:1/v1", models: { fast: "default-model" } },
      wide: { endpoint: "http://lab:2/v1", models: { fast: "wide-model" } },
      near: { endpoint: "http://lab:3/v1", models: { fast: "near-model" } },
    },
    harnesses: { claude: {} },
    improve,
  }) as unknown as AkmConfig;

const resolve = (
  improve: Record<string, unknown>,
  options: Partial<Parameters<typeof resolveImproveExecution>[0]> = {},
) => resolveImproveExecution({ config: config(improve), processName: "reflect", ...options })?.runner;

describe("resolveImproveExecution — the nearest layer that names a target wins", () => {
  test("with nothing named, model work runs on the default connection", () => {
    expect(resolve({})).toMatchObject({ kind: "connection", name: "default" });
  });

  test("improve-wide, then the process, then the current invocation", () => {
    expect(resolve({ connection: "wide" })).toMatchObject({ name: "wide" });
    expect(resolve({ connection: "wide" }, { process: { connection: "near" } })).toMatchObject({ name: "near" });
    expect(
      resolve({ connection: "wide" }, { process: { connection: "near" }, current: { connection: "default" } }),
    ).toMatchObject({ name: "default" });
  });

  test("a nearer harness replaces a farther connection, and a nearer connection a farther harness", () => {
    expect(resolve({ connection: "wide" }, { process: { harness: "claude" } })).toMatchObject({
      kind: "harness",
      name: "claude",
    });
    expect(resolve({ harness: "claude" }, { process: { connection: "near" } })).toMatchObject({
      kind: "connection",
      name: "near",
    });
  });

  test("a flag's name (a connection by that name, else a harness) replaces a process's choice of the other kind", () => {
    expect(resolve({}, { process: { connection: "near" }, current: { engine: "claude" } })).toMatchObject({
      kind: "harness",
      name: "claude",
    });
    expect(resolve({}, { process: { harness: "claude" }, current: { engine: "near" } })).toMatchObject({
      kind: "connection",
      name: "near",
    });
  });
});
