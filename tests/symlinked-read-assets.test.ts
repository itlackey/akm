/**
 * Reads follow symlinks. Installing a bundle is the trust decision, so an env
 * file, a secret file or an asset that is a symlink to a file outside its
 * directory resolves like any other file. Names with `..` segments are still
 * refused by the name grammar.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveEnvPath, resolveSecretPath } from "../src/core/env-secret-ref";
import { resolveAssetPath } from "../src/sources/resolve";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

/** A stash whose `<typeDir>/<fileName>` is a symlink to a file in an unrelated directory. */
function stashWithLink(typeDir: string, fileName: string, targetName: string, body: string): { stash: string } {
  const stash = makeStashDir();
  const outside = makeSandboxDir("akm-outside");
  disposers.push(stash, outside);
  const target = path.join(outside.dir, targetName);
  fs.writeFileSync(target, body);
  fs.mkdirSync(path.join(stash.dir, typeDir), { recursive: true });
  fs.symlinkSync(target, path.join(stash.dir, typeDir, fileName));
  return { stash: stash.dir };
}

describe("reads follow symlinks that leave their directory", () => {
  test("resolveSecretPath resolves a symlinked secret", async () => {
    const { stash } = stashWithLink("secrets", "token", "real-secret", "s3cret");
    const resolved = await withEnv({ AKM_BUNDLE_DIR: stash, AKM_CONFIG_DIR: undefined }, async () =>
      resolveSecretPath("secrets/token"),
    );
    expect(resolved.absPath).toBe(path.join(stash, "secrets", "token"));
    expect(fs.readFileSync(resolved.absPath, "utf8")).toBe("s3cret");
  });

  test("resolveEnvPath resolves a symlinked env file", async () => {
    const { stash } = stashWithLink("env", "prod.env", "real.env", "A=1\n");
    const resolved = await withEnv({ AKM_BUNDLE_DIR: stash, AKM_CONFIG_DIR: undefined }, async () =>
      resolveEnvPath("env/prod"),
    );
    expect(resolved.absPath).toBe(path.join(stash, "env", "prod.env"));
    expect(fs.readFileSync(resolved.absPath, "utf8")).toBe("A=1\n");
  });

  test("resolveAssetPath resolves a symlinked asset by its authored path", async () => {
    const { stash } = stashWithLink("scripts", "link.sh", "real.sh", "#!/bin/sh\necho linked");
    const resolved = await resolveAssetPath(stash, "script", "link.sh");
    expect(fs.readFileSync(resolved, "utf8")).toBe("#!/bin/sh\necho linked");
    expect(path.basename(resolved)).toBe("link.sh");
  });

  test("a name with a '..' segment is still refused", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    fs.writeFileSync(path.join(stash.dir, "outside.sh"), "#!/bin/sh\necho escape");

    await expect(resolveAssetPath(stash.dir, "script", "../outside.sh")).rejects.toThrow(
      "Ref resolves outside the stash root.",
    );
    await withEnv({ AKM_BUNDLE_DIR: stash.dir, AKM_CONFIG_DIR: undefined }, async () => {
      expect(() => resolveSecretPath("secrets/../outside")).toThrow(/relative path segments/);
      expect(() => resolveEnvPath("env/../outside")).toThrow(/relative path segments/);
    });
  });
});
