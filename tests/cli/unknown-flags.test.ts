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
import { assertKnownFlags, assertNoStrayPositionals, type FlagScanCommand } from "../../src/cli/unknown-flags";
import { UsageError } from "../../src/core/errors";

const check = (args: string[]): void => assertKnownFlags(main as unknown as FlagScanCommand, args);
const checkPositionals = (args: string[]): void => assertNoStrayPositionals(main as unknown as FlagScanCommand, args);

/** The UsageError a gate throws, for asserting code/hint. */
const thrownBy = (gate: (args: string[]) => void, args: string[]): UsageError => {
  try {
    gate(args);
  } catch (err) {
    if (err instanceof UsageError) return err;
    throw err;
  }
  throw new Error(`expected "${args.join(" ")}" to be rejected`);
};
const errorFor = (args: string[]): UsageError => thrownBy(check, args);
const strayFor = (args: string[]): UsageError => thrownBy(checkPositionals, args);

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

  test("a flag STABILITY lists as gone names its replacement, not an edit-distance guess", () => {
    const shape = errorFor(["search", "foo", "--shape", "agent"]);
    expect(shape.hint()).toContain("--detail normal");
    expect(shape.hint()).not.toContain("--type");
    expect(errorFor(["env", "create", "x", "--target", "b"]).hint()).toContain("`--bundle`");
    expect(errorFor(["config", "path", "--all"]).hint()).toContain("`akm doctor info`");
    // `--target` is only gone where STABILITY says so.
    expect(errorFor(["search", "foo", "--target", "b"]).hint() ?? "").not.toContain("is gone");
  });

  test("proposal reject --yes and -y are gone: reject never asks", () => {
    for (const flag of ["--yes", "-y"]) {
      const err = errorFor(["proposal", "reject", "abc", "--reason", "r", flag]);
      expect(err.code).toBe("UNKNOWN_FLAG");
      expect(err.hint()).toContain("reject never asks");
    }
  });

  test("rejects the retired --require-engines and --engine, and never suggests them", () => {
    expect(errorFor(["improve", "--require-engines"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["agent", "--engine", "lab"]).code).toBe("UNKNOWN_FLAG");
    const err = errorFor(["improve", "--require-targets"]);
    expect(err.code).toBe("UNKNOWN_FLAG");
    expect(err.hint()).not.toContain("--require-engines");
  });

  test("rejects a flag that exists on a DIFFERENT command", () => {
    // `--full` is akm index's flag; `akm search` never declared it.
    expect(errorFor(["search", "foo", "--full"]).code).toBe("UNKNOWN_FLAG");
  });

  test("`akm search --assets` is gone: nothing ever printed its asset hits", () => {
    expect(errorFor(["search", "foo", "--from", "registry", "--assets"]).code).toBe("UNKNOWN_FLAG");
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

  test("the removed duplicate flags are unknown: lint --auto-fix, migrate apply --dry-run", () => {
    expect(errorFor(["lint", "--auto-fix"]).code).toBe("UNKNOWN_FLAG");
    expect(errorFor(["migrate", "apply", "--dry-run"]).code).toBe("UNKNOWN_FLAG");
  });

  test("0.10.261120's `doctor scheduler sync` flags that 0.11 drops name what replaces them", () => {
    expect(errorFor(["doctor", "scheduler", "sync", "--dry-run"]).hint()).toContain("`akm migrate status`");
    expect(errorFor(["doctor", "scheduler", "sync", "--bundle", "b"]).hint()).toContain("drop it");
    for (const flag of ["--prune", "--yes", "--id"]) {
      expect(errorFor(["doctor", "scheduler", "sync", flag]).hint()).toContain(
        "removes the old per-task scheduler rows",
      );
    }
    expect(() => check(["doctor", "scheduler", "sync", "--rebind"])).not.toThrow();
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

  test("a group with no listing reports the missing subcommand, not its flags", () => {
    expect(() => check(["task", "--status=reverted"])).not.toThrow();
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

describe("a command takes only the positionals it declares", () => {
  test("`akm bundle create <path>` is refused, and the hint is the --dir spelling", () => {
    // It used to ignore the path and initialize the default bundle.
    const err = strayFor(["bundle", "create", "/some/folder"]);
    expect(err.message).toBe('akm bundle create takes no positional arguments, but got "/some/folder".');
    expect(err.hint()).toContain("akm bundle create --dir /some/folder");
    expect(strayFor(["bundle", "create", "--set-default", "/some/folder"]).hint()).toContain("--dir /some/folder");
    expect(strayFor(["setup", "/some/folder", "--yes"]).hint()).toContain("akm setup --dir /some/folder");
  });

  test("one more than a command declares is refused, and the hint says to quote", () => {
    // It used to search for "deploy" alone.
    const err = strayFor(["search", "deploy", "script"]);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toBe('akm search takes 1 positional argument, but got 2: "deploy" "script".');
    expect(err.hint()).toContain("Quote a value that contains spaces");
    expect(err.hint()).toContain("akm search --help");
  });

  test.each([
    [
      "a second value",
      ["config", "get", "output.format", "extra"],
      'takes 1 positional argument, but got 2: "output.format" "extra"',
    ],
    ["a third value", ["bundle", "rename", "old", "new", "extra"], "takes 2 positional arguments, but got 3"],
    ["one beside an optional positional", ["sync", "team", "extra"], "takes 1 positional argument, but got 2"],
    ["one beside a positional that sits next to subcommands", ["improve", "skills", "extra"], "akm improve takes 1"],
    [
      "a second id where only one is read",
      ["proposal", "reject", "p-1", "p-2", "--reason", "stale"],
      'got 2: "p-1" "p-2"',
    ],
    ["one given after `--`", ["bundle", "remove", "--yes", "--", "team", "extra"], 'got 2: "team" "extra"'],
    ["one before the child command", ["env", "run", "env/prod", "extra", "--", "tool"], 'got 2: "env/prod" "extra"'],
  ])("refuses %s", (_label, args, message) => {
    expect(strayFor(args as string[]).message).toContain(message as string);
  });

  test("a token after `--` is a positional too", () => {
    expect(strayFor(["bundle", "create", "--", "/some/folder"]).message).toContain('"/some/folder"');
    expect(strayFor(["log", "--", "tail"]).message).toContain('"tail"');
  });

  test.each([
    ["a command that writes", ["backups", "prune", "old"]],
    ["a migration", ["migrate", "apply", "now"]],
    ["a nested leaf", ["doctor", "metrics", "usage", "extra"]],
    ["a leaf under a group that takes a positional", ["improve", "report", "extra"]],
    ["a subcommand only `doctor metrics` has", ["metrics", "usage"]],
    ["a retired subcommand", ["log", "tail"]],
    ["a command with no flags of its own", ["config", "path", "extra"]],
    ["a command that does not declare the global flags", ["hints", "extra"]],
  ])("%s", (_label, args) => {
    const err = strayFor(args as string[]);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toContain(`"${args.at(-1)}"`);
    expect(err.hint()).toContain("--help");
  });

  test.each([
    ["no positional at all", ["bundle", "create"]],
    ["a flag's value", ["bundle", "create", "--dir", "/some/folder", "--set-default"]],
    ["a flag's value, equals form", ["bundle", "create", "--dir=/some/folder"]],
    ["a global flag before the command", ["--format", "json", "bundle", "create"]],
    ["a global flag's value on a command that does not declare it", ["hints", "--format", "json"]],
    ["a repeated value flag", ["health", "--windows", "name=a,since=1,until=2", "--windows", "name=b,since=2,until=3"]],
    ["a short alias", ["index", "-q"]],
    ["a declared positional", ["bundle", "show", "team"]],
    ["an optional positional", ["bundle", "update", "npm:@scope/pkg"]],
    ["a positional beside subcommands", ["improve", "skills"]],
    ["every declared positional", ["config", "set", "output.format", "json"]],
    ["a value flag between positionals", ["bundle", "rename", "old", "--format", "json", "new"]],
    ["a short bundle whose last letter takes a value", ["sync", "team", "-qm", "release notes"]],
    ["a bare `-` for stdin", ["import", "-"]],
    ["positionals given after `--`", ["bundle", "rename", "--dry-run", "--", "old", "new"]],
    ["a positional after `--` beside a flag before it", ["task", "enable", "--bundle=team", "--", "nightly"]],
    ["any number of ids to accept, which the command reads itself", ["proposal", "accept", "p-1", "p-2"]],
    ["any number of ids to reopen", ["proposal", "reopen", "p-1", "p-2"]],
    ["a second token on show, which refuses it with its own message", ["show", "knowledge/a", "auth"]],
    ["a second token on doctor prompt, likewise", ["doctor", "prompt", "lessons/a", "extra"]],
    ["a child command after `--`", ["env", "run", "env/prod", "--", "tool", "arg"]],
    ["a child command after two positionals", ["secret", "run", "secrets/key", "TOKEN", "--", "tool", "arg"]],
    ["a task input's value", ["task", "run", "nightly", "--scope", "all"]],
    ["a workflow parameter's value", ["workflow", "run", "workflows/health", "--labels", "one"]],
    ["an input's value through `akm run`", ["run", "tasks/nightly", "--scope", "all"]],
  ])("accepts %s", (_label, args) => {
    expect(() => checkPositionals(args as string[])).not.toThrow();
  });

  test("`akm exec` keeps the command after `--`, and refuses a token before it", () => {
    expect(() => checkPositionals(["exec", "--env", "env/prod", "--", "tool", "arg"])).not.toThrow();
    expect(strayFor(["exec", "tool", "--", "arg"]).message).toBe(
      'akm exec takes no positional arguments, but got "tool".',
    );
  });

  test("`akm help <command> <subcommand>` still prints the command's help", () => {
    expect(() => checkPositionals(["help", "bundle", "create"])).not.toThrow();
  });

  test("an unknown command is left to the unknown-command error", () => {
    expect(() => checkPositionals(["distill", "abc"])).not.toThrow();
    expect(() => checkPositionals(["bundle", "/some/folder"])).not.toThrow();
    expect(() => checkPositionals(["doctor", "metrics", "bogus"])).not.toThrow();
  });
});
