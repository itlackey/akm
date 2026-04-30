/**
 * Subprocess test: real SIGINT delivery cleans up registered fns before
 * exit (#267).
 *
 * The real handler calls `process.exit(130)` — fatal inside the test
 * runner. So we drive it from a child Bun process and assert via side
 * effects (touchstones written to a tmpdir) that every cleanup fn ran.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { benchMkdtemp } from "./tmp";

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-bench-cleanup-sigint-"): string {
  const dir = benchMkdtemp(prefix);
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(import.meta.dir, "..", "..");

describe("SIGINT delivery → registered cleanups run (#267)", () => {
  test("subprocess: SIGINT runs every registered cleanup fn before exit", () => {
    const sigDir = makeTempDir();
    const a = path.join(sigDir, "a.touchstone");
    const b = path.join(sigDir, "b.touchstone");
    const c = path.join(sigDir, "c.touchstone");

    // Inline driver script. It registers three cleanup fns that each touch
    // a unique file, then `process.kill(pid, 'SIGINT')` and waits long
    // enough for the handler to fire `process.exit(130)`.
    const driverScript = `
import { registerCleanup } from ${JSON.stringify(path.join(repoRoot, "tests", "bench", "cleanup.ts"))};
import fs from "node:fs";

registerCleanup(() => fs.writeFileSync(${JSON.stringify(a)}, "a"));
registerCleanup(() => fs.writeFileSync(${JSON.stringify(b)}, "b"));
registerCleanup(async () => {
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(${JSON.stringify(c)}, "c");
});

process.kill(process.pid, "SIGINT");
// Stay alive until the signal handler fires + exits.
await new Promise((r) => setTimeout(r, 2000));
`;
    const scriptPath = path.join(sigDir, "driver.mjs");
    fs.writeFileSync(scriptPath, driverScript);

    const result = spawnSync("bun", ["run", scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
    });

    // Exit code 130 = signalled exit (POSIX convention 128 + SIGINT(2)).
    expect(result.status).toBe(130);
    // All three cleanup fns ran before exit.
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.existsSync(c)).toBe(true);
  });

  test("subprocess: SIGTERM also triggers cleanup", () => {
    const sigDir = makeTempDir();
    const a = path.join(sigDir, "term.touchstone");
    const driverScript = `
import { registerCleanup } from ${JSON.stringify(path.join(repoRoot, "tests", "bench", "cleanup.ts"))};
import fs from "node:fs";

registerCleanup(() => fs.writeFileSync(${JSON.stringify(a)}, "term"));
process.kill(process.pid, "SIGTERM");
await new Promise((r) => setTimeout(r, 2000));
`;
    const scriptPath = path.join(sigDir, "driver-term.mjs");
    fs.writeFileSync(scriptPath, driverScript);

    const result = spawnSync("bun", ["run", scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(130);
    expect(fs.existsSync(a)).toBe(true);
  });
});
