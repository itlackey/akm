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
import { change } from "../../../src/workspace/config";
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

type Detected = Awaited<ReturnType<typeof setup.detect>>;

describe("setup.apply", () => {
  test("creates the library and the config, and a second run changes nothing", async () => {
    const dir = library();
    const first = (await setup.apply({ dir })) as Detected;
    expect(first.stashDir).toBe(dir);
    expect(fs.existsSync(path.join(dir, "knowledge"))).toBe(true);
    const config = savedConfig();
    expect(Object.values(config.bundles)).toContainEqual(expect.objectContaining({ path: dir, writable: true }));
    expect(config.defaultBundle).toBeDefined();

    const before = fs.readFileSync(getConfigPath(), "utf8");
    await setup.apply({ dir });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("a named harness is enabled, and akm's model calls stay off it unless learning names it", async () => {
    const restore = claudeOnPath();
    try {
      const after = await setup.apply({ dir: library(), harness: ["claude"] });
      expect(savedConfig().harnesses.claude.modelWork).toBe(false);
      expect(savedConfig().improve?.harness).toBeUndefined();
      expect(after.modelCalls.platform).toBeNull();
      expect(after.modelCalls.description).toStartWith("off: no connection is configured");
      expect(after.enabled).toEqual(["claude"]);
      expect(after.harnesses[0]?.modelWorkNote).toBeString();
    } finally {
      restore();
    }
  });

  test("learning on an enabled agent runs akm's model calls there, even with a connection", async () => {
    const restore = claudeOnPath();
    try {
      const after = await setup.apply({ dir: library(), harness: ["claude"], learning: "claude" });
      expect(savedConfig().harnesses.claude.modelWork).toBeUndefined();
      expect(after.modelCalls.platform).toBe("claude");
      change({
        set: { "connections.lab.endpoint": "http://localhost:1/v1", "connections.lab.models.fast": "m" },
        unset: [],
      });
      expect((await setup.detect()).modelCalls.platform).toBe("claude");
      const back = await setup.apply({ dir: library(), harness: ["claude"] });
      expect(back.modelCalls.platform).toBeNull();
      expect(back.modelCalls.description).toContain('connection "lab"');
      expect(savedConfig().improve?.harness).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("several agents leave one default harness, and learning may name any of them", async () => {
    const restore = claudeOnPath();
    fs.writeFileSync(path.join(ctx.storage.root, "bin", "codex"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
    try {
      const after = await setup.apply({ dir: library(), harness: ["claude", "codex"], learning: "codex" });
      expect(Object.keys(savedConfig().harnesses).sort()).toEqual(["codex", "default"]);
      expect(savedConfig().harnesses.default.platform).toBe("claude");
      expect(savedConfig().improve.harness).toBe("codex");
      expect(after.modelCalls.platform).toBe("codex");
      expect(after.enabled.sort()).toEqual(["claude", "codex"]);
    } finally {
      restore();
    }
  });

  test("learning on an agent that is not enabled is ignored with a warning", async () => {
    const warned: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warned.push(String(args[0]));
    });
    const restore = claudeOnPath();
    try {
      const after = await setup.apply({ dir: library(), harness: ["claude"], learning: "codex" });
      expect(after.modelCalls.platform).toBeNull();
      expect(warned.some((line) => line.includes("codex is not enabled"))).toBe(true);
    } finally {
      restore();
    }
  });

  test("an agent program on PATH is not enabled unless named, in one write", async () => {
    const restore = claudeOnPath();
    try {
      const after = await setup.apply({ dir: library() });
      expect(savedConfig().harnesses).toBeUndefined();
      expect(after.modelCalls.platform).toBeNull();
      expect(after.harnesses.map((item) => item.platform)).toContain("claude");
    } finally {
      restore();
    }
  });

  test("a harness already configured is left as it is", async () => {
    await setup.apply({ dir: library(), harness: ["claude"] });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    await setup.apply({ dir: library() });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
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
