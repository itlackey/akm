import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

describe("npm bin contract", () => {
  test("published bins point at portable launchers with a Node fallback", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.akm).toBe("dist/akm");
    expect(pkg.bin?.["akm-migrate-storage"]).toBe("dist/akm-migrate-storage");

    const akmLauncher = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", "akm"), "utf8");
    expect(akmLauncher.startsWith("#!/bin/sh")).toBe(true);
    expect(akmLauncher).toContain('exec bun "$SCRIPT_DIR/cli.js" "$@"');
    expect(akmLauncher).toContain('exec node "$SCRIPT_DIR/cli-node.mjs" "$@"');

    const migrateLauncher = fs.readFileSync(
      path.join(REPO_ROOT, "scripts", "node-runtime", "akm-migrate-storage"),
      "utf8",
    );
    expect(migrateLauncher.startsWith("#!/bin/sh")).toBe(true);
    expect(migrateLauncher).toContain('exec bun "$SCRIPT_DIR/scripts/migrate-storage.js" "$@"');
    expect(migrateLauncher).toContain('exec node "$SCRIPT_DIR/migrate-storage-node.mjs" "$@"');

    for (const sourceFile of ["cli-node.mjs", "migrate-storage-node.mjs"]) {
      const wrapper = fs.readFileSync(path.join(REPO_ROOT, "scripts", "node-runtime", sourceFile), "utf8");
      expect(wrapper.startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });
});
