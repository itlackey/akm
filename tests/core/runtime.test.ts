// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { compareSemver, installCommand, isBun } from "../../src/core/runtime";

describe("runtime: isBun", () => {
  test("reports the Bun runtime when present (tests run under Bun)", () => {
    expect(isBun()).toBe(typeof (globalThis as { Bun?: unknown }).Bun !== "undefined");
  });
});

describe("runtime: installCommand", () => {
  test("emits the runtime-appropriate install command", () => {
    const cmd = installCommand("@huggingface/transformers");
    if (isBun()) {
      expect(cmd).toBe("bun add @huggingface/transformers");
    } else {
      expect(cmd).toBe("npm install @huggingface/transformers");
    }
  });
});

describe("runtime: compareSemver", () => {
  test("orders core versions", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  test("tolerates a leading v and uneven segment counts", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
    expect(compareSemver("1", "1.0.1")).toBeLessThan(0);
  });

  test("ranks a pre-release below the corresponding release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  test("orders pre-release identifiers", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    // numeric identifiers have lower precedence than alphanumeric
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  test("treats malformed numeric segments as zero rather than throwing", () => {
    expect(() => compareSemver("1.x.0", "1.0.0")).not.toThrow();
    expect(compareSemver("1.x.0", "1.0.0")).toBe(0);
  });

  test("matches the update-available semantics used by self-update", () => {
    // newer remote => update available (compare < 0)
    expect(compareSemver("0.8.2", "0.9.0") < 0).toBe(true);
    // same or older remote => no update
    expect(compareSemver("0.9.0", "0.9.0") < 0).toBe(false);
    expect(compareSemver("0.9.1", "0.9.0") < 0).toBe(false);
  });
});
