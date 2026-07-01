import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { copyIncludedPaths } from "../../src/sources/include";
import { copyDirectoryContents } from "../../src/sources/providers/provider-utils";
import { type Cleanup, makeSandboxDir } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("source provider copy safety", () => {
  test("copyDirectoryContents skips symlinks instead of dereferencing them", () => {
    const source = makeSandboxDir("akm-provider-copy-src");
    const dest = makeSandboxDir("akm-provider-copy-dest");
    cleanup = () => {
      dest.cleanup();
      source.cleanup();
    };

    const outside = path.join(dest.dir, "outside.txt");
    fs.writeFileSync(path.join(source.dir, "safe.md"), "safe\n", "utf8");
    fs.writeFileSync(outside, "outside\n", "utf8");
    fs.symlinkSync(outside, path.join(source.dir, "escaped.md"));

    copyDirectoryContents(source.dir, dest.dir);

    expect(fs.readFileSync(path.join(dest.dir, "safe.md"), "utf8")).toBe("safe\n");
    expect(fs.existsSync(path.join(dest.dir, "escaped.md"))).toBe(false);
  });

  test("copyIncludedPaths rejects symlink include targets", () => {
    const source = makeSandboxDir("akm-include-src");
    const dest = makeSandboxDir("akm-include-dest");
    cleanup = () => {
      dest.cleanup();
      source.cleanup();
    };

    fs.writeFileSync(path.join(source.dir, "real.md"), "inside\n", "utf8");
    fs.symlinkSync(path.join(source.dir, "real.md"), path.join(source.dir, "leak.md"));

    expect(() => copyIncludedPaths(["leak.md"], source.dir, dest.dir)).toThrow("must not be a symlink");
    expect(fs.existsSync(path.join(dest.dir, "leak.md"))).toBe(false);
  });
});
