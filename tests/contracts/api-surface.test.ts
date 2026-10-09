// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-cli/api` is the one supported programmatic entry point (AGENTS.md,
 * docs/reference/api.md). This pins its runtime export list, the shape of
 * `curate()`'s rejections, and that the hand-written `dist/api.d.ts` source
 * stays assignable both ways to what `src/api.ts` really exports.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type * as Declared from "../../scripts/node-runtime/api";
import * as api from "../../src/api";

const ROOT = path.resolve(import.meta.dir, "..", "..");

// Compile-time: the declarations the package ships and the source agree.
// (`bunx tsc --noEmit` is the gate; at runtime these are just assignments.)
const sourceAsDeclared: typeof Declared = {} as typeof api;
const declaredAsSource: typeof api = {} as typeof Declared;
void sourceAsDeclared;
void declaredAsSource;

describe("akm-cli/api surface", () => {
  test("exports exactly curate", () => {
    expect(Object.keys(api).sort()).toEqual(["curate"]);
    expect(typeof api.curate).toBe("function");
  });

  test("curate(query, options?) takes a query and an optional options object", () => {
    // `options` is defaulted, so only `query` counts toward `length`.
    expect(api.curate.length).toBe(1);
  });

  test("returns a promise and rejects with message + code, not by throwing synchronously", async () => {
    const pending = api.curate("");
    expect(pending).toBeInstanceOf(Promise);
    const err = await pending.then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(err?.message).toContain("A curate query is required");
  });

  test("rejects a format the contract does not offer", async () => {
    const err = await api.curate("deploy", { format: "yaml" as "text" }).then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe("INVALID_FORMAT_VALUE");
  });

  test("rejects a non-positive limit with the CLI's code", async () => {
    const err = await api.curate("deploy", { limit: 0 }).then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe("INVALID_FLAG_VALUE");
  });

  test("the shipped declarations list curate and CurateOptions", () => {
    const dts = fs.readFileSync(path.join(ROOT, "scripts", "node-runtime", "api.d.ts"), "utf8");
    expect(dts).toContain("export function curate(query: string, options?: CurateOptions): Promise<string>;");
    expect(dts).toContain("export interface CurateOptions");
  });
});
