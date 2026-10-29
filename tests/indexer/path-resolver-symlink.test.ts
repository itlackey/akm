/**
 * The indexer's disk resolution follows symlinks (#1237): installing a bundle
 * is the trust decision, so an asset that is a symlink to a file outside the
 * bundle resolves to its target. A name that climbs out with `..` does not.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveAssetPath } from "../../src/indexer/walk/path-resolver";
import { makeSandboxDir, makeStashDir, type SandboxedDir } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

describe("indexer disk resolution", () => {
  test("a symlinked script outside the bundle resolves to its target", async () => {
    const stash = makeStashDir();
    const outside = makeSandboxDir("akm-outside");
    disposers.push(stash, outside);
    const target = path.join(outside.dir, "real.sh");
    fs.writeFileSync(target, "#!/bin/sh\necho linked\n");
    fs.mkdirSync(path.join(stash.dir, "scripts"), { recursive: true });
    fs.symlinkSync(target, path.join(stash.dir, "scripts", "linked.sh"));

    const resolved = await resolveAssetPath("scripts/linked.sh", { mode: "disk-only", stashDir: stash.dir });
    expect(resolved).toBe(fs.realpathSync(target));
  });
});
