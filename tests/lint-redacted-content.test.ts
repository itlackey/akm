// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("akm lint redacted durable content (#962)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => storage.cleanup());

  test("reports an asset containing [REDACTED] without rewriting it", async () => {
    const file = path.join(storage.stashDir, "knowledge", "damaged.md");
    const content = "---\ndescription: Damaged asset\nupdated: 2026-09-19\n---\n\nCosmetic [REDACTED]ments.\n";
    fs.writeFileSync(file, content);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir), fix: true });
    const findings = result.flagged.filter((finding) => finding.issue === "redacted-content");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("knowledge/damaged.md");
    expect(findings[0]?.fixed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  test("does not flag clean asset content", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "clean.md"),
      "---\ndescription: Clean asset\n---\n\nOrdinary content.\n",
    );

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((finding) => finding.issue === "redacted-content")).toEqual([]);
  });
});
