// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { formatMigratePlain } from "../../src/output/text/migrate";

test("the plain plan names the keys filed in credentials.json, the config notes and the assets' engine keys", () => {
  const text = formatMigratePlain({
    status: "ready",
    configFile: {
      credentials: ["default", "embedding"],
      notes: ['engines.lab.apiKeyFile: its key moves to credentials.json as "default".'],
    },
    taskFiles: { changed: 0, skipped: 2, blocked: 0 },
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
