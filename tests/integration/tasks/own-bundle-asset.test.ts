// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A task's assets in its own bundle resolve as assets of another bundle do, through the asset facade (F34): an asset
 * akm lists is found with its authored file, an asset the walk does not reach or that is no asset is not found, and
 * every not-found is `Task asset <bundle>//<id> was not found.`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { NotFoundError } from "../../../src/core/errors";
import { resolveOwnBundleAsset } from "../../../src/tasks/task-ref";
import { makeSandboxDir, type SandboxedDir } from "../../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

function bundle(): string {
  const made = makeSandboxDir("akm-own-bundle-asset");
  sandboxes.push(made);
  return made.dir;
}

function writeFile(filePath: string, content = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const resolve = (dir: string, type: string, name: string) =>
  resolveOwnBundleAsset({ name: "work", path: dir }, { type, name });

describe("a task's own-bundle asset (F34)", () => {
  test("a script is its authored file", () => {
    const dir = bundle();
    writeFile(path.join(dir, "scripts", "deploy.sh"), "#!/bin/sh\necho hello");
    writeFile(path.join(dir, "scripts", "analyze.py"), "print('hello')");

    expect(resolve(dir, "script", "deploy.sh")).toEqual({
      file: path.join(dir, "scripts", "deploy.sh"),
      bundleRoot: dir,
    });
    expect(resolve(dir, "script", "analyze.py").file).toBe(path.join(dir, "scripts", "analyze.py"));
  });

  test("a skill is its SKILL.md", () => {
    const dir = bundle();
    writeFile(path.join(dir, "skills", "ops", "SKILL.md"), "# Ops Skill");

    expect(resolve(dir, "skill", "ops").file).toBe(path.join(dir, "skills", "ops", "SKILL.md"));
  });

  test("an installed-stash style ref outside its type folder resolves by its outdated spelling", () => {
    const dir = bundle();
    writeFile(path.join(dir, "tools", "agents", "svelte-file-editor.md"), "---\nname: svelte-file-editor\n---\nUse.\n");
    writeFile(path.join(dir, "tools", "skills", "svelte-code-writer", "SKILL.md"), "# Svelte code writer\n");

    expect(resolve(dir, "agent", "tools/agents/svelte-file-editor").file).toBe(
      path.join(dir, "tools", "agents", "svelte-file-editor.md"),
    );
    expect(resolve(dir, "skill", "tools/skills/svelte-code-writer").file).toBe(
      path.join(dir, "tools", "skills", "svelte-code-writer", "SKILL.md"),
    );
  });

  test("what is not found says so in one sentence, whatever the reason", () => {
    const dir = bundle();
    const notFound = (type: string, name: string, conceptId: string) => {
      expect(() => resolve(dir, type, name)).toThrow(new NotFoundError(`Task asset work//${conceptId} was not found.`));
    };
    // No type folder at all.
    notFound("script", "deploy.sh", "scripts/deploy.sh");
    // A file where the type folder should be.
    writeFile(path.join(dir, "skills"), "not a directory");
    notFound("skill", "ops", "skills/ops");
    // A missing file, and a file that is no script.
    writeFile(path.join(dir, "scripts", "readme.txt"), "not a script");
    notFound("script", "nonexistent.sh", "scripts/nonexistent.sh");
    notFound("script", "readme.txt", "scripts/readme.txt");
    // A script the walk does not reach.
    writeFile(path.join(dir, "scripts", ".hidden", "run.sh"), "#!/bin/sh\n");
    notFound("script", ".hidden/run.sh", "scripts/.hidden/run.sh");
  });

  test("a name that climbs out of its folder is refused", () => {
    const dir = bundle();
    writeFile(path.join(dir, "outside.sh"), "#!/bin/sh\necho escape");

    expect(() => resolve(dir, "script", "../outside.sh")).toThrow(/relative path segments/);
  });
});
