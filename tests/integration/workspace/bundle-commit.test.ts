// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: real git repositories in isolated storage.
/**
 * A bundle commit: `bundles.list` reports how many files `akm sync` would commit, and `bundles.commit` runs `akm sync`
 * for one bundle and says what it did (the commit, pushed or not, or why nothing was committed).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { bundles } from "../../../src/workspace";
import { makeConfig } from "../../_helpers/factories";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let plain: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  makeGitRepo({ dir: storage.stashDir });
  plain = path.join(storage.root, "plain");
  fs.mkdirSync(path.join(plain, "knowledge"), { recursive: true });
  writeSandboxConfig({
    ...makeConfig(storage.stashDir),
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true, adapter: "akm" },
      plain: { path: plain, writable: true, adapter: "akm" },
    },
  });
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const put = (rel: string, content = "text\n") => {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const card = async (name: string) =>
  (
    (await bundles.list()) as { bundles: Array<{ name: string; git: { uncommitted: number | null } | null }> }
  ).bundles.find((entry) => entry.name === name);

describe("the uncommitted count", () => {
  test("is the number of files a sync would commit, not the lines of git status", async () => {
    expect((await card("stash"))?.git?.uncommitted).toBe(0);
    put("knowledge/a.md");
    put("knowledge/b.md");
    put("notes/deep/c.md");
    fs.writeFileSync(path.join(storage.stashDir, "README.md"), "# changed\n");
    put("ignored.log");
    fs.writeFileSync(path.join(storage.stashDir, ".gitignore"), "*.log\n");

    // `git status --porcelain` shows `notes/` as one line; a sync commits its file. Ignored files are left out.
    expect((await card("stash"))?.git?.uncommitted).toBe(5);
  });

  test("a bundle that is not a git repository has no count", async () => {
    expect((await card("plain"))?.git).toBeNull();
  });
});

describe("committing a bundle", () => {
  test("commits what the count said and reports the commit", async () => {
    put("knowledge/a.md");
    put("notes/deep/c.md");

    const result = await bundles.commit({ bundle: "stash", message: "Add notes" });

    expect(result).toMatchObject({ bundle: "stash", committed: true, pushed: false, skipped: false });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(storage.stashDir, ["log", "-1", "--format=%s"]).trim()).toBe("Add notes");
    expect(git(storage.stashDir, ["status", "--porcelain"])).toBe("");
    expect((await card("stash"))?.git?.uncommitted).toBe(0);
    expect(readEvents({ type: "sync" }).events.map((event) => event.metadata?.name)).toContain("stash");
  });

  test("with nothing to commit it says why, and creates no commit", async () => {
    const head = git(storage.stashDir, ["rev-parse", "HEAD"]);

    const result = await bundles.commit({ bundle: "stash" });

    expect(result).toMatchObject({ bundle: "stash", committed: false, pushed: false, skipped: false });
    expect(result.output).toContain("nothing to commit");
    expect(git(storage.stashDir, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("a bundle that is not a git repository is refused with the reason", async () => {
    await expect(bundles.commit({ bundle: "plain" })).rejects.toThrow("not a Git working tree");
  });

  test("a bundle that is not configured is refused", async () => {
    await expect(bundles.commit({ bundle: "missing" })).rejects.toThrow('No configured bundle named "missing"');
  });
});
