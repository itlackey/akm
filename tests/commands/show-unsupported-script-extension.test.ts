// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { showLocal } from "../../src/commands/read/show";
import { resetConfigCache } from "../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "primary",
    bundles: {
      primary: {
        path: storage.stashDir,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
  });
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

async function captureShowError(ref: string): Promise<Error> {
  try {
    await showLocal({ ref });
    throw new Error(`expected ${ref} to fail`);
  } catch (error) {
    return error as Error;
  }
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  return {
    warnings,
    restore: () => {
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    },
  };
}

describe("show unsupported AKM script extension diagnostics", () => {
  test.each([
    "scripts/readme.txt",
    "primary//scripts/readme.txt",
  ])("renders an existing unsupported canonical script path as plain text, with a warning, for %s", async (ref) => {
    write(storage.stashDir, "scripts/readme.txt", "UNSUPPORTED_SCRIPT_SENTINEL\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { warnings, restore } = captureWarnings();
    let response: Awaited<ReturnType<typeof showLocal>>;
    try {
      response = await showLocal({ ref });
    } finally {
      restore();
    }

    expect(response.type).toBe("script");
    expect(response.content).toContain("UNSUPPORTED_SCRIPT_SENTINEL");
    expect(warnings.some((w) => w.includes("readme.txt") && w.includes("plain text"))).toBe(true);
  });

  test("matches an unsupported extension case-insensitively while requiring the exact authored spelling", async () => {
    write(storage.stashDir, "scripts/report.TxT", "MIXED_CASE_SENTINEL\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { restore } = captureWarnings();
    let exact: Awaited<ReturnType<typeof showLocal>>;
    try {
      exact = await showLocal({ ref: "scripts/report.TxT" });
    } finally {
      restore();
    }
    const wrongCase = await captureShowError("scripts/report.txt");

    expect(exact.content).toContain("MIXED_CASE_SENTINEL");
    expect(wrongCase.message).toMatch(/asset not found/i);
  });

  test("keeps bare names and absent unsupported-looking canonical paths on the normal not-found path", async () => {
    write(storage.stashDir, "scripts/readme.txt", "BARE_NAME_SENTINEL\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    for (const ref of ["readme.txt", "scripts/absent.txt", "primary//scripts/absent.TXT"]) {
      const error = await captureShowError(ref);
      expect(error.message, ref).toMatch(/asset not found/i);
      expect(error.message, ref).not.toMatch(/supported script extension/i);
    }
  });

  test.each([
    "scripts/deploy.sh",
    "primary//scripts/deploy.SH",
  ])("leaves supported script extension resolution unchanged for %s", async (ref) => {
    const authored = ref.endsWith(".SH") ? "scripts/deploy.SH" : "scripts/deploy.sh";
    const scriptPath = write(storage.stashDir, authored, "#!/bin/sh\necho supported\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    await expect(showLocal({ ref })).resolves.toMatchObject({
      type: "script",
      path: scriptPath,
    });
  });

  test("reads and renders an unsupported script's body rather than reporting a file that exists as not found", async () => {
    write(storage.stashDir, "scripts/private.txt", "SCRIPT_BODY_IS_SHOWN\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { restore } = captureWarnings();
    let response: Awaited<ReturnType<typeof showLocal>>;
    try {
      response = await showLocal({ ref: "scripts/private.txt" });
    } finally {
      restore();
    }

    expect(response.content).toContain("SCRIPT_BODY_IS_SHOWN");
  });

  test("renders an unsupported script that is a symlink to a file outside the source (#1237)", async () => {
    const outsidePath = write(storage.root, "outside/private.txt", "OUTSIDE_SCRIPT_SENTINEL\n");
    const authoredPath = path.join(storage.stashDir, "scripts", "private.txt");
    fs.symlinkSync(outsidePath, authoredPath);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { restore } = captureWarnings();
    let response: Awaited<ReturnType<typeof showLocal>>;
    try {
      response = await showLocal({ ref: "scripts/private.txt" });
    } finally {
      restore();
    }

    expect(response.content).toContain("OUTSIDE_SCRIPT_SENTINEL");
  });
});

describe("show unsupported scripts and first-owner arbitration", () => {
  test("a valid earlier physical owner wins before a later AKM unsupported-path diagnostic", async () => {
    resetConfigCache();
    storage.cleanup();
    storage = withIsolatedAkmStorage({ AKM_BUNDLE_DIR: undefined });
    const early = path.join(storage.root, "early");
    const later = path.join(storage.root, "later");
    const earlyPath = write(early, "scripts/readme.txt.md", "# EARLY_OKF_OWNER\n");
    write(later, "scripts/readme.txt", "LATE_UNSUPPORTED_AKM_FILE\n");
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "early",
      bundles: {
        early: {
          path: early,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
        later: {
          path: later,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });
    resetConfigCache();
    await akmIndex({ stashDir: early, full: true });

    await expect(showLocal({ ref: "scripts/readme.txt" })).resolves.toMatchObject({
      path: earlyPath,
      content: expect.stringContaining("EARLY_OKF_OWNER"),
    });
    const { restore } = captureWarnings();
    try {
      await expect(showLocal({ ref: "later//scripts/readme.txt" })).resolves.toMatchObject({
        content: expect.stringContaining("LATE_UNSUPPORTED_AKM_FILE"),
      });
    } finally {
      restore();
    }
  });
});
