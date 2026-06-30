import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

describe("npm bin contract", () => {
  test("published bins point at Node wrappers", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.akm).toBe("dist/cli-node.mjs");
    expect(pkg.bin?.["akm-migrate-storage"]).toBe("dist/migrate-storage-node.mjs");

    for (const sourceFile of ["cli-node.mjs", "migrate-storage-node.mjs"]) {
      const wrapper = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", sourceFile), "utf8");
      expect(wrapper.startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });
});
