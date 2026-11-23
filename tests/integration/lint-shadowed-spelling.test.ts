// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` runs the adapter's own `validate` on an akm bundle too (the sweep alone cannot see how storage spells a
 * concept): a concept held by more than one file is reported with the file that is used and the ones ignored, and a
 * Markdown file whose content suggests another type than its path gives is told where to go.
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

const SKILL = "---\nname: x\ndescription: A skill\n---\n# X\n";

describe("akm lint on an akm bundle", () => {
  test("reports a concept held by two files: skills/x.md and skills/x/SKILL.md", async () => {
    storage = withIsolatedAkmStorage();
    write("skills/x/SKILL.md", SKILL);
    write("skills/x.md", "# loose\n");

    const result = await akmLint({ dir: storage.stashDir });
    const found = result.flagged.filter((issue) => issue.issue === "shadowed-spelling");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "skills/x/SKILL.md", ref: "skills/x" });
    expect(found[0]?.detail).toContain('"skills/x/SKILL.md" is used and skills/x.md ignored');
  });

  test("a bundle with one spelling per concept has no such finding", async () => {
    storage = withIsolatedAkmStorage();
    write("skills/x/SKILL.md", SKILL);
    write("skills/y/SKILL.md", SKILL.replace("name: x", "name: y"));

    const result = await akmLint({ dir: storage.stashDir });
    expect(result.flagged.filter((issue) => issue.issue === "shadowed-spelling")).toEqual([]);
  });

  test("a Markdown file typed by its path is told when its content says another type", async () => {
    storage = withIsolatedAkmStorage();
    write("knowledge/deploy.md", "---\nagent: planner\ndescription: Deploys\nupdated: 2026-01-01\n---\n\n# Deploy\n");

    const result = await akmLint({ dir: storage.stashDir });
    const hint = result.flagged.find((issue) => issue.issue === "type-from-content");
    expect(hint?.file).toBe("knowledge/deploy.md");
    expect(hint?.detail).toContain("commands/");
  });
});
