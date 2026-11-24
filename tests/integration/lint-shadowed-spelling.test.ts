// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` runs the adapter's own `validate` on an akm bundle too (the sweep alone cannot see how storage spells a
 * concept): a concept held by more than one file is reported with the file that is used and the ones ignored.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
afterEach(() => storage?.cleanup());

function write(rel: string, content: string): void {
  const full = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

const TASK = "schedule: '@daily'\ncommand: echo hi\n";

describe("akm lint on an akm bundle", () => {
  test("reports a concept held by two files: tasks/x.md and tasks/x.yml", async () => {
    storage = withIsolatedAkmStorage();
    write("tasks/x.yml", TASK);
    write("tasks/x.md", "# loose\n");

    const result = await akmLint({ dir: storage.stashDir });
    const found = result.flagged.filter((issue) => issue.issue === "shadowed-spelling");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "tasks/x.yml", ref: "tasks/x" });
    expect(found[0]?.detail).toContain('"tasks/x.yml" is used and tasks/x.md ignored');
  });

  test("a bundle with one spelling per concept has no such finding", async () => {
    storage = withIsolatedAkmStorage();
    write("tasks/x.yml", TASK);
    write("tasks/y.yml", TASK);

    const result = await akmLint({ dir: storage.stashDir });
    expect(result.flagged.filter((issue) => issue.issue === "shadowed-spelling")).toEqual([]);
  });
});
