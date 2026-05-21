/**
 * Tests for `supplementPathForSchedulerContext` in the agent spawn wrapper.
 *
 * Verifies that:
 *   • PATH containing the user home directory is returned unchanged (interactive shell).
 *   • Stripped PATH (no home dir) is supplemented with candidates that exist on disk.
 *   • Candidates that do not exist on disk are not added.
 *   • Empty PATH receives only candidates that exist.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { supplementPathForSchedulerContext } from "../../src/integrations/agent/spawn";

const home = os.homedir();

describe("supplementPathForSchedulerContext", () => {
  test("returns PATH unchanged when it contains the home directory (interactive shell)", () => {
    const interactivePath = [path.join(home, ".bun", "bin"), "/usr/bin", "/bin"].join(path.delimiter);
    const result = supplementPathForSchedulerContext(interactivePath);
    expect(result).toBe(interactivePath);
  });

  test("returns PATH unchanged when a sub-path of home appears (e.g. ~/.cargo/bin already present)", () => {
    const withHome = [path.join(home, ".cargo", "bin"), "/usr/bin"].join(path.delimiter);
    const result = supplementPathForSchedulerContext(withHome);
    expect(result).toBe(withHome);
  });

  test("prepends existing candidate dirs when PATH is stripped (no home dir)", () => {
    // Use a PATH that definitely has no home-dir segment.
    const strippedPath = "/usr/bin:/bin";
    const result = supplementPathForSchedulerContext(strippedPath);
    // The result must still end with the original stripped PATH.
    expect(result.endsWith(strippedPath)).toBe(true);
    // Each prepended segment must be a real directory (the function only adds existing dirs).
    const prepended = result.slice(0, result.length - strippedPath.length).replace(/:$/, "");
    if (prepended.length > 0) {
      for (const segment of prepended.split(path.delimiter).filter(Boolean)) {
        // Every prepended segment must be one of the known candidates.
        const isKnownCandidate = [
          path.join(home, ".bun", "bin"),
          path.join(home, ".cargo", "bin"),
          path.join(home, ".local", "bin"),
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
        ].includes(segment);
        expect(isKnownCandidate).toBe(true);
      }
    }
  });

  test("does not duplicate entries already present in a stripped PATH", () => {
    // /usr/local/bin is a candidate — if it's already in PATH it must not be added twice.
    const withLocalBin = "/usr/local/bin:/usr/bin:/bin";
    const result = supplementPathForSchedulerContext(withLocalBin);
    const segments = result.split(path.delimiter);
    const count = segments.filter((s) => s === "/usr/local/bin").length;
    expect(count).toBe(1);
  });

  test("only adds candidate dirs that exist on disk (stripped PATH case)", () => {
    // The function only prepends directories that fs.existsSync returns true for.
    // Verify all added segments are real existing directories.
    const strippedPath = "/usr/bin:/bin";
    const result = supplementPathForSchedulerContext(strippedPath);
    const added = result
      .split(path.delimiter)
      .filter((s) => !strippedPath.split(path.delimiter).includes(s))
      .filter(Boolean);
    for (const dir of added) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  test("handles empty PATH string without throwing", () => {
    const result = supplementPathForSchedulerContext("");
    // Result should be either empty or contain only real directories.
    const segments = result.split(path.delimiter).filter(Boolean);
    for (const seg of segments) {
      expect(existsSync(seg)).toBe(true);
    }
  });
});
