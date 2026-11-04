// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `setup.detect` and `setup.apply` of `src/workspace/setup.ts` against a sandbox: the child is the real `akm setup`. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "../../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { setup } from "../../../src/workspace";
import { ctx, expectUsage, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();
// Detection reads the home directory, which is the machine's own unless a test gives it another.
let realHome: string | undefined;
beforeEach(() => {
  realHome = process.env.HOME;
  process.env.HOME = path.join(ctx.storage.root, "home");
  fs.mkdirSync(process.env.HOME);
});
afterEach(() => {
  process.env.HOME = realHome;
  _resetWarnOnceForTests();
  _setWarnSinkForTests();
});

const library = () => path.join(ctx.storage.root, "library");
const savedConfig = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
/** A `claude` on PATH for this test, which setup's detection finds as an installed agent program. */
function claudeOnPath() {
  const bin = path.join(ctx.storage.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho 2.1.283\n", { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  return () => {
    process.env.PATH = before;
  };
}

describe("setup.apply", () => {
  test("creates the library and the config, and a second run changes nothing", async () => {
    const dir = library();
    const first = (await setup.apply({ dir })) as { bundleDir: string; stashCreated: boolean };
    expect(first).toMatchObject({ bundleDir: dir, stashCreated: true });
    expect(fs.existsSync(path.join(dir, "knowledge"))).toBe(true);
    const config = savedConfig();
    expect(Object.values(config.bundles)).toContainEqual({ path: dir, writable: true });
    expect(config.defaultBundle).toBeDefined();

    const before = fs.readFileSync(getConfigPath(), "utf8");
    const second = (await setup.apply({ dir })) as { stashCreated: boolean };
    expect(second.stashCreated).toBe(false);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("a named harness lands in the config", async () => {
    await setup.apply({ dir: library(), harness: ["claude"] });
    expect(savedConfig().harnesses).toHaveProperty("claude");
  });

  test("an agent program that setup would enable by default is not enabled unless named", async () => {
    const restore = claudeOnPath();
    try {
      await setup.apply({ dir: library() });
      expect(savedConfig().harnesses).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("a harness already configured is left as it is", async () => {
    await setup.apply({ dir: library(), harness: ["claude"] });
    await setup.apply({ dir: library() });
    expect(savedConfig().harnesses).toHaveProperty("claude");
  });

  test("an unknown field is ignored with one warning", async () => {
    const warned: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warned.push(String(args[0]));
    });
    await setup.apply({ dir: library(), endpoint: "http://localhost:1/v1" } as never);
    await setup.apply({ dir: library(), endpoint: "http://localhost:1/v1" } as never);
    expect(warned.filter((line) => line.includes('unknown field "endpoint"'))).toHaveLength(1);
    expect(JSON.stringify(savedConfig())).not.toContain("localhost:1");
  });

  test("refuses a relative directory and an unknown agent program", async () => {
    await expectUsage(() => setup.apply({ dir: "library" }), undefined, "absolute");
    await expectUsage(() => setup.apply({ dir: library(), harness: ["nonesuch"] }), "INVALID_FLAG_VALUE");
  });
});

describe("setup.detect", () => {
  test("suggests the library the config already has", async () => {
    const dir = library();
    await setup.apply({ dir });
    expect((await setup.detect()).stashDir).toBe(dir);
  });

  test("reports the library location and agent programs without writing or contacting anything", async () => {
    const restore = claudeOnPath();
    const fetched = spyOn(globalThis, "fetch");
    try {
      const found = await setup.detect();
      expect(path.isAbsolute(found.stashDir)).toBe(true);
      expect(found.harnesses.map((item) => item.platform)).toContain("claude");
      expect(fetched).not.toHaveBeenCalled();
      expect(fs.existsSync(getConfigPath())).toBe(false);
    } finally {
      fetched.mockRestore();
      restore();
    }
  });
});
