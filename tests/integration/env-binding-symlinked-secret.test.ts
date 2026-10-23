/**
 * Classification: opens a real database (`resolveEnvBinding` appends an
 * `env_access` event to state.db).
 *
 * A `${secrets/name}` token reads the secret even when that file is a symlink
 * to a file outside `secrets/` (installing a bundle is the trust decision).
 * A token whose body is not a well-formed ref (a `..` path) is plain text and
 * reads nothing.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveEnvBinding } from "../../src/commands/env/env-binding";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

function stashWithEnv(envBody: string): { stash: string; outside: string } {
  const stash = makeStashDir();
  const outside = makeSandboxDir("akm-outside");
  disposers.push(stash, outside);
  fs.mkdirSync(path.join(stash.dir, "env"), { recursive: true });
  fs.mkdirSync(path.join(stash.dir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(stash.dir, "env", "prod.env"), envBody);
  return { stash: stash.dir, outside: outside.dir };
}

describe("resolveEnvBinding secret substitution", () => {
  test("substitutes a secret that is a symlink to a file outside secrets/", async () => {
    const { stash, outside } = stashWithEnv("TOKEN=${secrets/token}\n");
    fs.writeFileSync(path.join(outside, "real"), "s3cret");
    fs.symlinkSync(path.join(outside, "real"), path.join(stash, "secrets", "token"));

    const binding = await withEnv({ AKM_BUNDLE_DIR: stash, AKM_CONFIG_DIR: undefined }, async () =>
      resolveEnvBinding("env/prod"),
    );
    expect(binding.values.TOKEN).toBe("s3cret");
    expect(binding.secretValues).toEqual(["s3cret"]);
  });

  test("a token with a '..' segment is not a ref, so nothing outside secrets/ is read", async () => {
    const { stash } = stashWithEnv("TOKEN=${secrets/../outside}\n");
    fs.writeFileSync(path.join(stash, "outside"), "leak");

    const binding = await withEnv({ AKM_BUNDLE_DIR: stash, AKM_CONFIG_DIR: undefined }, async () =>
      resolveEnvBinding("env/prod"),
    );
    expect(binding.values.TOKEN).toBe("${secrets/../outside}");
    expect(binding.secretValues).toEqual([]);
  });
});
