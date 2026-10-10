// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-cli/api` `curate()` against the real CLI.
 *
 * Classification (AGENTS.md ORG-03): spawns the real CLI (`spawnSync`) for the
 * equivalence baseline and `curate()` opens the real index database.
 *
 * Pins: (1) `curate()` returns byte-for-byte the stdout of
 * `akm --detail agent -q curate … --format <fmt>` on the same sandbox stash, for
 * text and json; (2) it rejects with the CLI's message and `code`; (3) calling
 * it repeatedly in one long-lived process sees config edits on disk, leaks no
 * file descriptors, and leaves quiet/verbose/stdout/env/cwd as the host had them.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { curate } from "../../../src/api";
import { isQuiet, isVerbose, setQuiet } from "../../../src/core/warn";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const CLI = path.join(import.meta.dir, "..", "..", "..", "src", "cli.ts");

let storage: IsolatedAkmStorage;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", [CLI, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function cliCurate(query: string, flags: string[] = []) {
  return runCli(["--detail", "agent", "-q", "curate", query, ...flags]);
}

function configPath(): string {
  return path.join(storage.configDir, "akm", "config.json");
}

/**
 * Open descriptors after a GC. bun:sqlite finalizes statements, and so closes
 * the file under an already-`close()`d handle, on GC; counting before that
 * would measure the collector, not whether `curate()` closes what it opens.
 */
async function openFdCount(): Promise<number> {
  Bun.gc(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  Bun.gc(true);
  return fs.readdirSync("/proc/self/fd").length;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  write(
    path.join(storage.stashDir, "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Deploy the app to production\n---\n# Deploy\nRun the deploy steps for production.\n",
  );
  write(
    path.join(storage.stashDir, "knowledge", "deploy-notes.md"),
    "---\ndescription: Production deploy notes and rollback steps\n---\n# Deploy notes\nHow to deploy and roll back production.\n",
  );
  write(
    path.join(storage.stashDir, "knowledge", "vpn.md"),
    "---\ndescription: VPN setup notes\n---\n# VPN\nHow to connect to the VPN.\n",
  );
  expect(runCli(["index"]).status).toBe(0);
});

afterEach(() => {
  storage.cleanup();
});

describe("curate() equals the CLI's stdout", () => {
  for (const format of ["text", "json"] as const) {
    test(`--format ${format}`, async () => {
      const cli = cliCurate("deploy production", ["--format", format]);
      expect(cli.status).toBe(0);
      expect(cli.stdout).toContain("deploy");
      expect(await curate("deploy production", { format })).toBe(cli.stdout);
    });
  }

  test("json is the default format, as in the CLI", async () => {
    const cli = cliCurate("deploy production", ["--format", "json"]);
    expect(await curate("deploy production")).toBe(cli.stdout);
  });

  test("--limit and --type", async () => {
    const cli = cliCurate("deploy", ["--limit", "1", "--type", "knowledge", "--format", "json"]);
    expect(cli.status).toBe(0);
    const out = await curate("deploy", { limit: 1, type: "knowledge", format: "json" });
    expect(out).toBe(cli.stdout);
    expect(JSON.parse(out).items).toHaveLength(1);
  });

  test("a query with no match is the same empty result", async () => {
    const cli = cliCurate("zzzqqq nothing matches", ["--format", "text"]);
    expect(await curate("zzzqqq nothing matches", { format: "text" })).toBe(cli.stdout);
  });
});

describe("curate() rejects the way the CLI fails", () => {
  async function rejection(promise: Promise<string>): Promise<Error & { code?: string }> {
    return promise.then(
      () => {
        throw new Error("expected curate() to reject");
      },
      (e: Error) => e,
    );
  }

  function cliError(r: { stderr: string }): { error: string; code?: string } {
    return JSON.parse(r.stderr) as { error: string; code?: string };
  }

  test("empty query", async () => {
    const cli = cliCurate("");
    expect(cli.status).toBe(2);
    const err = await rejection(curate(""));
    expect(err.message).toBe(cliError(cli).error);
    expect(err.code).toBe(cliError(cli).code);
    expect(err.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("invalid --limit", async () => {
    const cli = cliCurate("deploy", ["--limit", "0"]);
    expect(cli.status).toBe(2);
    const err = await rejection(curate("deploy", { limit: 0 }));
    expect(err.message).toBe(cliError(cli).error);
    expect(err.code).toBe(cliError(cli).code);
  });

  test("invalid config.json", async () => {
    fs.writeFileSync(configPath(), "{ not json");
    const cli = cliCurate("deploy");
    expect(cli.status).toBe(78);
    const err = await rejection(curate("deploy"));
    expect(err.message).toBe(cliError(cli).error);
    expect(err.code).toBe(cliError(cli).code);
  });
});

describe("repeated calls inside one long-lived process", () => {
  test("see config edits on disk and leave the host's state alone", async () => {
    const stdoutWrite = spyOn(process.stdout, "write");
    const stderrWrite = spyOn(process.stderr, "write");
    const envBefore = JSON.stringify(process.env);
    const cwdBefore = process.cwd();
    const argvBefore = [...process.argv];
    const quietBefore = isQuiet();
    const verboseBefore = isVerbose();

    const first = await curate("deploy production", { format: "json" });
    expect(JSON.parse(first).items.length).toBeGreaterThan(0);
    // Warm the process (module graph, embed cache) before counting descriptors.
    await curate("deploy production", { format: "text" });
    const fdsBefore = await openFdCount();

    // A config edit between calls is picked up exactly as a separate CLI run would.
    fs.writeFileSync(configPath(), "{ not json");
    const broken = await curate("deploy production").then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(broken?.code).toBe("INVALID_CONFIG_FILE");

    writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: ["skill"] } });
    // writeSandboxConfig merges over the broken file's fallback ({}), so this is a valid config again.
    const cli = cliCurate("deploy production", ["--format", "json"]);
    const edited = await curate("deploy production", { format: "json" });
    expect(edited).toBe(cli.stdout);
    expect(JSON.parse(edited).items.map((i: { type: string }) => i.type)).not.toContain("skill");

    // Overlapping calls with different formats do not share output state.
    const [a, b] = await Promise.all([
      curate("deploy production", { format: "json" }),
      curate("deploy production", { format: "text" }),
    ]);
    expect(() => JSON.parse(a)).not.toThrow();
    expect(b.startsWith("{")).toBe(false);

    for (let i = 0; i < 10; i++) await curate("deploy production", { format: "json" });

    expect(await openFdCount()).toBeLessThanOrEqual(fdsBefore + 2);
    expect(isQuiet()).toBe(quietBefore);
    expect(isVerbose()).toBe(verboseBefore);
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(process.env)).toBe(envBefore);
    expect(process.cwd()).toBe(cwdBefore);
    expect(process.argv).toEqual(argvBefore);
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  test("a rejected call does not leave quiet set", async () => {
    const quietBefore = isQuiet();
    await curate("").catch(() => undefined);
    expect(isQuiet()).toBe(quietBefore);
    setQuiet(false);
    await curate("").catch(() => undefined);
    expect(isQuiet()).toBe(false);
  });
});
