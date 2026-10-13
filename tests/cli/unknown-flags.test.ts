// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Undeclared flags must fail, declared ones must not.
 *
 * citty forwards argv to mri, which has no strict mode: an undeclared flag was
 * collected and silently ignored, so `akm lint --fail-on-flaged` (one
 * transposed letter in a flag STABILITY.md documents as a CI contract) parsed
 * fine, exited 0, and the gate never fired.
 *
 * The false-positive direction matters more than the true-positive one —
 * rejecting a VALID invocation is worse than the silence being replaced — so
 * most of these pin flags that must keep working.
 */

import { describe, expect, test } from "bun:test";
import { main } from "../../src/cli";
import { assertKnownFlags, type FlagScanCommand } from "../../src/cli/unknown-flags";
import { UsageError } from "../../src/core/errors";

const check = (args: string[]): void => assertKnownFlags(main as unknown as FlagScanCommand, args);

/** The thrown UsageError, for asserting code/hint. */
const errorFor = (args: string[]): UsageError => {
  try {
    check(args);
  } catch (err) {
    if (err instanceof UsageError) return err;
    throw err;
  }
  throw new Error(`expected "${args.join(" ")}" to be rejected`);
};

describe("rejects undeclared flags", () => {
  test("a typo'd CI gate flag fails instead of silently not gating", () => {
    const err = errorFor(["lint", "--fail-on-flaged"]);

    expect(err.code).toBe("UNKNOWN_FLAG");
    expect(err.message).toContain("--fail-on-flaged");
    expect(err.hint()).toContain("--fail-on-flagged");
  });

  test("suggests the intended flag when one is close", () => {
    expect(errorFor(["search", "foo", "--limt", "3"]).hint()).toContain("--limit");
  });

  test("rejects a flag that exists on a DIFFERENT command", () => {
    // `--full` is akm index's flag; `akm search` never declared it.
    expect(errorFor(["search", "foo", "--full"]).code).toBe("UNKNOWN_FLAG");
  });

  test("rejects both the space and equals spellings", () => {
    expect(errorFor(["show", "knowledge/a", "--jsn"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["show", "knowledge/a", "--jsn=1"]).code).toBe("UNKNOWN_FLAG");
  });

  test("`akm feedback --failure-mode` is gone: nothing read what it stored", () => {
    for (const flag of [["--failure-mode", "outdated"], ["--failure-mode=outdated"]]) {
      const err = errorFor(["feedback", "skills/a", "--negative", "--reason", "x", ...flag]);
      expect(err.code).toBe("UNKNOWN_FLAG");
      expect(err.message).toContain("--failure-mode");
    }
  });
});

describe("accepts every legitimate spelling", () => {
  test.each([
    ["global string flag", ["search", "foo", "--format", "json"]],
    ["global flag, equals form", ["search", "foo", "--format=json"]],
    ["command flag with a value", ["search", "foo", "--limit", "3"]],
    ["repeated flags", ["search", "foo", "--type", "skill", "--type", "command"]],
    ["boolean negation", ["setup", "--no-init"]],
    ["short alias", ["index", "-q"]],
    ["bundled boolean aliases", ["proposal", "accept", "p-1", "-qy"]],
    ["short alias with attached value", ["sync", "-mrelease"]],
    ["nested subcommand flags", ["proposal", "new", "skill", "demo", "--task", "do a thing"]],
    ["three-level nesting", ["bundle", "add", "github:owner/repo", "--writable"]],
    ["kebab-cased flag", ["lint", "--fail-on-flagged"]],
    ["help anywhere", ["search", "--help"]],
  ])("%s", (_label, args) => {
    expect(() => check(args as string[])).not.toThrow();
  });

  test("`--no-` negates a declared boolean but never a value flag", () => {
    // `--no-limit` used to be accepted by resolving against the value flag
    // `--limit`; mri then handed `limit: false` to a string parser, so the
    // user got an internal error (exit 70) instead of a usage error.
    expect(() => check(["setup", "--no-init"])).not.toThrow();
    expect(errorFor(["search", "foo", "--no-limit"]).code).toBe("UNKNOWN_FLAG");
  });

  test("a value that looks like a flag is not scanned as one", () => {
    expect(() => check(["feedback", "skills/a", "--negative", "--reason", "--not-a-flag"])).not.toThrow();
  });

  test("everything after `--` is passthrough", () => {
    expect(() => check(["env", "run", "env/prod", "--", "tool", "--anything-at-all"])).not.toThrow();
  });

  test("a bare `-` and negative numbers are not flags", () => {
    expect(() => check(["import", "-"])).not.toThrow();
    expect(() => check(["log", "--limit", "-5"])).not.toThrow();
  });

  test("one-dash long names are parsed as short bundles, not accepted as long flags", () => {
    expect(errorFor(["lint", "-auto-fix"]).code).toBe("UNKNOWN_FLAG");
  });

  test("workflow run reserves unknown long flags for exact workflow parameters", () => {
    expect(() =>
      check(["workflow", "run", "workflows/health", "--include_processes=true", "--labels", "one", "--labels", "two"]),
    ).not.toThrow();
    expect(errorFor(["workflow", "run", "workflows/health", "-x"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["workflow", "status", "workflows/health", "--include_processes"]).code).toBe("UNKNOWN_FLAG");
  });
});

describe("stands down when the command itself is the problem", () => {
  test("an unknown command reports the command, not its flags", () => {
    // citty's UNKNOWN_COMMAND names the real problem; a flag error would be
    // a confusing distraction.
    expect(() => check(["distill", "--source-run", "abc"])).not.toThrow();
  });

  test("a bare group reports the missing subcommand, not its flags", () => {
    expect(() => check(["proposal", "--status=reverted"])).not.toThrow();
  });

  test("a spelling an earlier release retired is a plain unknown flag, not a pass-through", () => {
    expect(errorFor(["show", "knowledge/a", "--scope", "user=x"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["index", "--enrich"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["proposal", "accept", "p-1", "--source", "distill"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["search", "foo", "--source", "local"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["curate", "foo", "--source", "local"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["remember", "note", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["clone", "skills/a", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["improve", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["task", "add", "nightly", "--schedule", "@daily", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["task", "history", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["task", "sync", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["import", "./a.md", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["env", "create", "prod", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["env", "remove", "prod", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["secret", "set", "key", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["proposal", "accept", "p-1", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["proposal", "diff", "p-1", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["proposal", "revert", "p-1", "--target", "team"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["search", "foo", "--shape", "agent"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["index", "--background"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["proposal", "extract", "--watch"]).code).toBe("UNKNOWN_FLAG");
  });

  test("an unknown flag carries no migration hint, only a did-you-mean when one is close", () => {
    expect(errorFor(["index", "--background"]).hint()).not.toContain("akm help migrate");
    expect(errorFor(["search", "foo", "--watch"]).hint()).not.toContain("proposal extract --auto");
  });
});

describe("improve --auto-accept (removed in 0.9, a hard error since 0.10)", () => {
  test("is an unknown flag, with or without a value", () => {
    expect(errorFor(["improve", "--auto-accept"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["improve", "--auto-accept", "90"]).code).toBe("UNKNOWN_FLAG");
  });
});
