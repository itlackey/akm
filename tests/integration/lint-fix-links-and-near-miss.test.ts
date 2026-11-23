// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint --fix` saves through the asset layer, and keeps what a plain write did: a file reached through a link that
 * leads inside the bundle is written where the link leads (the link stays), a link that leaves the bundle is refused,
 * and a task `.yaml` near-miss, which is no asset, is saved as it lies.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import type { EventEnvelope } from "../../src/core/events-types";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const UNSTAMPED = "---\nname: note\ntype: memory\n---\n\nSome content.\n";

let storage: IsolatedAkmStorage;
afterEach(() => storage?.cleanup());

function put(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe("--fix through a link", () => {
  test("a link to a file inside the bundle is written where it leads, and stays a link", async () => {
    storage = withIsolatedAkmStorage();
    const target = put(storage.stashDir, "elsewhere/real.md", UNSTAMPED);
    fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
    const link = path.join(storage.stashDir, "memories", "link.md");
    fs.symlinkSync(target, link);

    const result = await akmLint({ fix: true, dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    expect(result.flagged.filter((issue) => issue.fixed === "failed")).toEqual([]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toMatch(/updated:/);
  });

  test("a link to a file outside the bundle is refused and the file it leads to is left as it is", async () => {
    storage = withIsolatedAkmStorage();
    const outside = put(storage.root, "outside/real.md", UNSTAMPED);
    fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
    fs.symlinkSync(outside, path.join(storage.stashDir, "memories", "escape.md"));

    const result = await akmLint({ fix: true, dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    const failed = result.flagged.filter((issue) => issue.file.endsWith("escape.md") && issue.fixed === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(fs.readFileSync(outside, "utf8")).toBe(UNSTAMPED);
  });
});

describe("a task .yaml near-miss is saved as it lies", () => {
  test("--fix-moved-refs rewrites a moved link in it", async () => {
    storage = withIsolatedAkmStorage();
    put(storage.stashDir, "memories/new.md", "---\ndescription: New\nupdated: 2026-11-01\n---\n\nBody.\n");
    const near = put(storage.stashDir, "tasks/nightly.yaml", "version: 4\nrun: echo see stash//memories/old\n");
    const moves = [
      { type: "moved", ref: "stash//memories/new", metadata: { from: "stash//memories/old" } },
    ] as unknown as EventEnvelope[];

    await akmLint({
      fixMovedRefs: true,
      dir: storage.stashDir,
      config: makeConfig(storage.stashDir),
      readMoves: () => moves,
    });

    expect(fs.readFileSync(near, "utf8")).toContain("stash//memories/new");
  });
});
