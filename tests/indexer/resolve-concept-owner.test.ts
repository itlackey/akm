/**
 * `resolveConceptOwner`: the one "where is asset X right now?" walk. Pure disk
 * work over an ordered source list; no index, no config, no database.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import {
  type ResolveAdapterConceptOwnerOptions,
  resolveConceptOwner,
} from "../../src/indexer/lookup/adapter-concept-owner";
import type { SearchSource } from "../../src/indexer/search/search-source";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

/** An akm-layout bundle root holding the given files (relative path -> body). */
function bundle(id: string, files: Record<string, string>): SearchSource {
  const root = makeSandboxDir(`akm-owner-${id}`);
  sandboxes.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root.dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { path: root.dir, registryId: id, adapterId: "akm" };
}

const resolve = (ref: string, sources: SearchSource[], options?: ResolveAdapterConceptOwnerOptions) =>
  resolveConceptOwner(parseBundleRef(ref), sources, options);

describe("resolveConceptOwner", () => {
  test("a qualified ref resolves inside its own bundle, ahead of an earlier bundle that has the same concept", () => {
    const first = bundle("first", { "scripts/deploy.sh": "echo first\n" });
    const second = bundle("second", { "scripts/deploy.sh": "echo second\n" });

    const match = resolve("second//scripts/deploy.sh", [first, second]);

    expect(match?.bundleId).toBe("second");
    expect(match?.source).toBe(second);
    expect(match?.owner.path).toBe(path.join(second.path, "scripts", "deploy.sh"));
  });

  test("an unqualified ref resolves to the first source in priority order that owns it", () => {
    const first = bundle("first", { "knowledge/only-first.md": "# first\n" });
    const second = bundle("second", { "scripts/deploy.sh": "echo second\n" });
    const third = bundle("third", { "scripts/deploy.sh": "echo third\n" });

    expect(resolve("scripts/deploy.sh", [first, second, third])?.bundleId).toBe("second");
    expect(resolve("scripts/deploy.sh", [third, second, first])?.bundleId).toBe("third");
  });

  test("an env ref finds either spelling of the file", () => {
    const stash = bundle("stash", { "env/prod.env": "A=1\n", "env/team/.env": "B=2\n" });

    expect(resolve("env/prod", [stash])?.owner.path).toBe(path.join(stash.path, "env", "prod.env"));
    expect(resolve("env/team/default", [stash])?.owner.path).toBe(path.join(stash.path, "env", "team", ".env"));
  });

  test("a bare secrets file with no extension resolves", () => {
    const stash = bundle("stash", { "secrets/token": "s3cret\n" });

    const match = resolve("secrets/token", [stash]);

    expect(match?.owner.path).toBe(path.join(stash.path, "secrets", "token"));
    expect(match?.adapterId).toBe("akm");
  });

  test("an env file marked sensitive resolves for a caller that asks, and stays hidden from the rest", () => {
    const stash = bundle("stash", {
      "env/prod.env": "A=1\n",
      "env/prod.sensitive": "",
      "secrets/token": "s3cret\n",
      "secrets/token.sensitive": "",
    });

    expect(resolve("env/prod", [stash])).toBeUndefined();
    expect(resolve("env/prod", [stash], { includeSensitive: true })?.owner.path).toBe(
      path.join(stash.path, "env", "prod.env"),
    );
    expect(resolve("secrets/token", [stash], { includeSensitive: true })?.owner.path).toBe(
      path.join(stash.path, "secrets", "token"),
    );
  });

  test("nothing is returned for a missing concept or an unknown bundle", () => {
    const stash = bundle("stash", { "scripts/deploy.sh": "echo\n" });

    expect(resolve("scripts/missing.sh", [stash])).toBeUndefined();
    expect(resolve("nobody//scripts/deploy.sh", [stash])).toBeUndefined();
    expect(resolve("scripts/deploy.sh", [])).toBeUndefined();
  });
});
