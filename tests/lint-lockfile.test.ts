/**
 * `scripts/lint-lockfile.ts`: bun.lock must resolve every direct dependency of
 * package.json to the package and version package.json asks for. The stale
 * alias this repository carried (`onnxruntime-node` resolved to
 * `onnxruntime-web`) is the case it exists for.
 */

import { describe, expect, test } from "bun:test";
import { lintLockfile } from "../scripts/lint-lockfile";

/** A bun.lock (JSONC: trailing commas) holding the given `name -> [identifier]` entries. */
function lockOf(entries: Record<string, string>): string {
  const packages = Object.entries(entries)
    .map(([name, resolved]) => `    ${JSON.stringify(name)}: [${JSON.stringify(resolved)}, "", {}, "sha512-x"],`)
    .join("\n");
  return `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "akm-cli" } },\n  "packages": {\n${packages}\n  }\n}\n`;
}

describe("lintLockfile", () => {
  test("accepts a lock that resolves each dependency to its own package, inside the declared spec", () => {
    const pkg = {
      dependencies: { "onnxruntime-node": "1.24.3", "@huggingface/tokenizers": "0.1.3", citty: "^0.2.2" },
      optionalDependencies: { "sqlite-vec": "^0.1.9" },
      devDependencies: { typescript: "^5.9.3" },
    };
    const lock = lockOf({
      "onnxruntime-node": "onnxruntime-node@1.24.3",
      "@huggingface/tokenizers": "@huggingface/tokenizers@0.1.3",
      citty: "citty@0.2.4",
      "sqlite-vec": "sqlite-vec@0.1.9",
      typescript: "typescript@5.9.3",
    });

    expect(lintLockfile(pkg, lock)).toEqual([]);
  });

  test("rejects the stale alias: onnxruntime-node resolved to onnxruntime-web", () => {
    const pkg = { dependencies: { "onnxruntime-node": "1.24.3" } };
    const lock = lockOf({ "onnxruntime-node": "onnxruntime-web@1.24.3" });

    const problems = lintLockfile(pkg, lock);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"onnxruntime-node"');
    expect(problems[0]).toContain('"onnxruntime-web"');
    expect(problems[0]).toContain("bun update onnxruntime-node");
  });

  test("an npm: alias in package.json must resolve to the package it names", () => {
    const pkg = {
      dependencies: { "ort-alias": "npm:onnxruntime-web@^1.24.0", "scoped-alias": "npm:@scope/real@2.0.0" },
    };

    expect(
      lintLockfile(pkg, lockOf({ "ort-alias": "onnxruntime-web@1.24.3", "scoped-alias": "@scope/real@2.0.0" })),
    ).toEqual([]);
    const problems = lintLockfile(
      pkg,
      lockOf({ "ort-alias": "onnxruntime-node@1.24.3", "scoped-alias": "@scope/real@2.0.0" }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"ort-alias"');
    expect(problems[0]).toContain('"onnxruntime-node"');
  });

  test("rejects a resolved version outside the declared range or pin, in any dependency field", () => {
    const pkg = {
      dependencies: { exact: "1.2.3", ranged: "^2.0.0" },
      optionalDependencies: { optional: "~1.1.0" },
      devDependencies: { dev: "^3.0.0" },
    };
    const lock = lockOf({
      exact: "exact@1.2.4",
      ranged: "ranged@2.9.0",
      optional: "optional@1.2.0",
      dev: "dev@3.0.0",
    });

    const problems = lintLockfile(pkg, lock);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"exact" to 1.2.4');
    expect(problems[0]).toContain('"1.2.3"');
    expect(problems[1]).toContain('"optional" to 1.2.0');
    expect(problems[1]).toContain("optionalDependencies");
  });

  test("a dependency with no lock entry is reported", () => {
    const problems = lintLockfile({ dependencies: { missing: "^1.0.0" } }, lockOf({ other: "other@1.0.0" }));

    expect(problems).toEqual(['"missing" (dependencies) has no entry in bun.lock; run `bun install`.']);
  });

  test("specs that are not semver ranges are not judged for their version", () => {
    const pkg = {
      dependencies: {
        tagged: "latest",
        fromGit: "github:owner/repo#abc123",
        local: "workspace:*",
        prerelease: "^1.0.0-beta.1",
      },
    };
    const lock = lockOf({
      tagged: "tagged@9.9.9",
      fromGit: "fromGit@github:owner-repo-abc123",
      local: "local@workspace:packages/local",
      prerelease: "prerelease@1.0.0-beta.4",
    });

    expect(lintLockfile(pkg, lock)).toEqual([]);
  });
});
