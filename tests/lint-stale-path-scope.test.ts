// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import type { AkmConfig } from "../src/core/config/config";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("stale-path: which paths this machine judges, and what a finding tells an agent", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  function note(relative: string, body: string, frontmatter = "description: Note\nupdated: 2026-11-01"): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\n${frontmatter}\n---\n${body}`);
  }

  async function stale(config: AkmConfig = makeConfig(storage.stashDir)) {
    const result = await akmLint({ dir: storage.stashDir, config });
    return result.flagged.filter((finding) => finding.issue === "stale-path");
  }

  test("a missing path under the bundle carries everything needed to find and correct it", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "knowledge", "guides"), { recursive: true });
    note("knowledge/a.md", `\nIntro.\nSee ${storage.stashDir}/knowledge/guides/gone.md for details.\n`);
    const [finding] = await stale();
    expect(finding).toMatchObject({
      ref: "knowledge/a",
      file: "knowledge/a.md",
      line: 7,
      path: `${storage.stashDir}/knowledge/guides/gone.md`,
      lineText: `See ${storage.stashDir}/knowledge/guides/gone.md for details.`,
      nearestExisting: `${storage.stashDir}/knowledge/guides`,
      reason: "missing",
    });
    expect(finding?.detail).toContain("nonexistent path");
  });

  test("a frontmatter path is reported on its frontmatter line", async () => {
    note("knowledge/a.md", "\nBody.\n", `description: Note\nupdated: 2026-11-01\nsource: ${storage.stashDir}/gone.md`);
    const [finding] = await stale();
    expect(finding).toMatchObject({ line: 4, lineText: `source: ${storage.stashDir}/gone.md` });
  });

  test("a /tmp path that does not exist is ephemeral", async () => {
    note("knowledge/a.md", "\nWrote /tmp/akm-6-gone/out.json earlier today.\n");
    expect((await stale())[0]).toMatchObject({ path: "/tmp/akm-6-gone/out.json", reason: "ephemeral" });
  });

  test("paths this machine cannot judge are not checked: /opt, /var, /etc, /root and other users' homes", async () => {
    note(
      "knowledge/a.md",
      "\nUse /opt/akm-6-gone/tool and /var/akm-6-gone/log and /etc/akm-6-gone.conf and /root/akm-6-gone and /home/akm-6-nobody/x.\n",
    );
    expect(await stale()).toEqual([]);
  });

  test("a path under the user's home is checked", async () => {
    note("knowledge/a.md", `\nConfig at ${os.homedir()}/akm-6-gone/config.json.\n`);
    expect((await stale())[0]).toMatchObject({ reason: "missing", nearestExisting: os.homedir() });
  });

  test("a path under a configured project root is checked, and an unconfigured one is not", async () => {
    note("knowledge/a.md", "\nSee /srv/akm-6-proj/src/gone.ts.\n");
    expect(await stale()).toEqual([]);
    const config = { ...makeConfig(storage.stashDir), projects: { demo: { paths: ["/srv/akm-6-proj"] } } };
    expect((await stale(config as AkmConfig))[0]?.path).toBe("/srv/akm-6-proj/src/gone.ts");
  });

  test("a path under another configured bundle root is checked", async () => {
    const other = path.join(storage.root, "other-bundle");
    fs.mkdirSync(other, { recursive: true });
    note("knowledge/a.md", `\nSee ${other}/knowledge/gone.md.\n`);
    const config = makeConfig(storage.stashDir);
    config.bundles = { ...config.bundles, other: { path: other, writable: false } } as AkmConfig["bundles"];
    expect((await stale(config))[0]).toMatchObject({ path: `${other}/knowledge/gone.md`, nearestExisting: other });
  });

  test("a path ends at a colon: `path:line` references and PATH-style lists are checked per path", async () => {
    fs.writeFileSync(path.join(storage.stashDir, "real.ts"), "x\n");
    note(
      "knowledge/a.md",
      `\nSee ${storage.stashDir}/real.ts:12 and PATH=${storage.stashDir}/gone-bin:${storage.stashDir}.\n`,
    );
    expect((await stale()).map((finding) => finding.path)).toEqual([`${storage.stashDir}/gone-bin`]);
  });

  test("a URL is not a path", async () => {
    note("knowledge/a.md", "\nFetch https://example.com/tmp/akm-6-gone/x and https://example.com/home/akm-6-gone/y.\n");
    expect(await stale()).toEqual([]);
  });
});
