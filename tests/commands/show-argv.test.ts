import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeShowArgv } from "../../src/commands/read/show";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

let cleanup: Cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function useStorage(): ReturnType<typeof withIsolatedAkmStorage> {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  return storage;
}

function writeFixture(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function runEntrypoint(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

// HARNESS GAP — KEPT AS A SUBPROCESS: `--shape summary` is rejected for every
// non-`show` command by an early, pre-execution gate in the guarded startup
// block of src/cli.ts (before any command runs). Per that block's own
// comment, the in-process harness (tests/_helpers/cli.ts `runCliCapture`)
// intentionally skips this startup block, so it only enforces the later,
// post-execution `shapeForCommand()` gate — by which point a write command
// like `remember` has already run. This test asserts the write did NOT
// happen, which only holds for the real subprocess entry point, so it stays
// on `spawnSync` rather than being converted.
function runEntrypointSpawn(args: string[]) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30_000,
  });
}

// Regression: normalizeShowArgv splits global flags from positional view-mode
// args and rebuilds argv. The global-flag allowlist must preserve the 0.8
// output flags (--shape, --verbose) — otherwise `akm show <ref> <view> --shape
// agent` silently drops the projection because process.argv is replaced before
// initOutputMode reads it.
describe("normalizeShowArgv preserves global output flags on the view-mode path", () => {
  const base = ["bun", "akm", "show", "knowledge:guide"];

  test("--shape <value> (space form) survives the rewrite", () => {
    const out = normalizeShowArgv([...base, "toc", "--shape", "agent"]);
    expect(out).toEqual(["bun", "akm", "show", "knowledge:guide", "--akmView", "toc", "--shape", "agent"]);
  });

  test("--shape=<value> (equals form) survives the rewrite", () => {
    const out = normalizeShowArgv([...base, "toc", "--shape=summary"]);
    expect(out).toContain("--shape=summary");
    expect(out).toContain("--akmView");
  });

  test("--verbose survives the rewrite on the section view path", () => {
    const out = normalizeShowArgv([...base, "section", "Auth", "--verbose"]);
    expect(out).toEqual([
      "bun",
      "akm",
      "show",
      "knowledge:guide",
      "--akmView",
      "section",
      "--akmHeading",
      "Auth",
      "--verbose",
    ]);
  });

  test("global flags before show are preserved when view-mode args are rewritten", () => {
    const out = normalizeShowArgv([
      "bun",
      "akm",
      "--format=json",
      "--shape",
      "summary",
      "show",
      "knowledge:guide",
      "toc",
    ]);
    expect(out).toEqual([
      "bun",
      "akm",
      "--format=json",
      "--shape",
      "summary",
      "show",
      "knowledge:guide",
      "--akmView",
      "toc",
    ]);
  });
});

describe("entrypoint global --shape=summary ordering", () => {
  test("allows global --shape=summary before show", async () => {
    const storage = useStorage();
    writeFixture(
      path.join(storage.stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );

    const result = await runEntrypoint(["--format=json", "--shape=summary", "show", "command:release.md"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.type).toBe("command");
    expect(json.name).toBe("release.md");
    expect(json.description).toBe("Release");
    expect(json).not.toHaveProperty("template");
  });

  test("rejects global --shape=summary before non-show commands before they run", () => {
    const storage = useStorage();

    const result = runEntrypointSpawn(["--format=json", "--shape=summary", "remember", "do not write"]);

    expect(result.status).toBe(2);
    const error = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(error.code).toBe("INVALID_SHAPE_VALUE");
    expect(fs.readdirSync(path.join(storage.stashDir, "memories"))).toEqual([]);
  });
});
