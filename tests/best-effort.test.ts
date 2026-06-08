// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bestEffort, bestEffortAsync } from "../src/core/best-effort";
import { isQuiet, resetVerbose, setQuiet, setVerbose } from "../src/core/warn";

describe("bestEffort (sync)", () => {
  afterEach(() => {
    resetVerbose();
  });

  test("returns the value when fn succeeds", () => {
    expect(bestEffort(() => 42)).toBe(42);
  });

  test("swallows a throw and returns undefined", () => {
    expect(
      bestEffort(() => {
        throw new Error("boom");
      }),
    ).toBeUndefined();
  });

  test("emits NOTHING to console at default (non-verbose) verbosity", () => {
    resetVerbose();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const result = bestEffort(() => {
      throw new Error("boom");
    }, "default-silent");
    expect(result).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("routes the swallowed error to the verbose seam only when verbose", () => {
    // The test harness sets quiet globally; the verbose seam still gates on
    // !quiet, so un-quiet for this assertion and restore afterwards.
    const prevQuiet = isQuiet();
    setQuiet(false);
    setVerbose(true);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const result = bestEffort(() => {
      throw new Error("boom");
    }, "verbose-visible");
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(firstArg).toContain("verbose-visible");
    warnSpy.mockRestore();
    setQuiet(prevQuiet);
  });
});

describe("bestEffortAsync", () => {
  afterEach(() => {
    resetVerbose();
  });

  test("resolves the value when fn succeeds", async () => {
    expect(await bestEffortAsync(async () => "ok")).toBe("ok");
  });

  test("swallows a rejection and resolves to undefined", async () => {
    expect(
      await bestEffortAsync(async () => {
        throw new Error("boom");
      }),
    ).toBeUndefined();
  });

  test("emits NOTHING at default verbosity", async () => {
    resetVerbose();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    await bestEffortAsync(async () => {
      throw new Error("boom");
    }, "async-default");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
