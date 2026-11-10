// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, spyOn, test } from "bun:test";
import { main } from "../../scripts/akm-migrate";
import { formatMigratePlain } from "../../src/output/text/migrate";

test("the plain plan names the keys filed in credentials.json, the config notes and the assets' engine keys", () => {
  const text = formatMigratePlain({
    status: "ready",
    configFile: {
      credentials: ["default", "embedding"],
      notes: ['engines.lab.apiKeyFile: its key moves to credentials.json as "default".'],
    },
    assetEngineKeys: { changed: 3, skipped: 1 },
  });

  expect(text).toContain("credentials.json: 2 key(s) (default, embedding)");
  expect(text).toContain("asset engine keys: 3 change, 1 skipped");
  expect(text).toContain("config notes:");
  expect(text).toContain('engines.lab.apiKeyFile: its key moves to credentials.json as "default".');
});

test("the plain plan lists the notes of the run that forgot the old engine names", () => {
  const text = formatMigratePlain({
    status: "current",
    assetEngineKeys: { changed: 0, skipped: 0, notes: ["--engine lab is now --connection default"] },
  });

  expect(text).toContain("engine name notes:");
  expect(text).toContain("  - --engine lab is now --connection default");
});

test("the plain plan counts the content refs and lists the shadowed ones", () => {
  const text = formatMigratePlain({
    status: "ready",
    assetContentRefs: {
      changed: 2,
      skipped: 0,
      refs: 5,
      shadowed: [{ bundleId: "primary", from: "knowledge/wikis/b", to: "wikis/b" }],
    },
  });

  expect(text).toContain("asset content refs: 5 in 2 file(s) change, 0 skipped, 1 shadowed");
  expect(text).toContain("  - primary: knowledge/wikis/b (now wikis/b)");
});

describe("akm-migrate CLI", () => {
  test.each(["--help", "-h", "help"])("%s prints standalone usage", async (flag) => {
    const log = spyOn(console, "log").mockImplementation(() => {});

    await main([flag]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("Usage: akm-migrate <command> [options]");
  });

  test("the surface is `status` and `apply`, nothing else", async () => {
    await expect(main([])).rejects.toThrow(/Choose `status` or `apply`/);
    // The per-generation verbs are gone: one tool, one plan.
    await expect(main(["task-v4-apply"])).rejects.toThrow(/Choose `status` or `apply/);
    await expect(main(["status", "--dry-run"])).rejects.toThrow(/`status` does not accept --dry-run/);
    await expect(main(["apply", "--dry-run"])).rejects.toThrow(/`apply` does not accept --dry-run/);
    await expect(main(["apply", "--force"])).rejects.toThrow(/`apply` does not accept --force/);
  });
});
