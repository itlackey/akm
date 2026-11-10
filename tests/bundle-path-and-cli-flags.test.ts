// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Small config and CLI fixes: `bundles.*.path` resolution, strict integer
 * flags, the shared duration grammar, `-showSimilar` in help, the
 * `--auto-accept` gone hint, empty `GITHUB_TOKEN`
 * and an accepted `$schema`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, renderUsage } from "citty";
import { normalizeConfigFile } from "../scripts/akm-migrate/config/normalize";
import { main } from "../src/cli";
import { parseIntegerFlag } from "../src/cli/parse-args";
import { assertKnownFlags, type FlagScanCommand } from "../src/cli/unknown-flags";
import { parseSinceArg } from "../src/commands/improve/extract";
import { parseWorkflowParameterFlags } from "../src/commands/workflow-cli";
import { resolveConfiguredBundlePath, resolveStashDir } from "../src/core/common";
import { parseAndValidateConfigText } from "../src/core/config/config";
import { UsageError } from "../src/core/errors";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { githubHeaders } from "../src/integrations/github";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withEnvSync, withIsolatedAkmStorage } from "./_helpers/sandbox";

const resolveValue = async <T>(v: T | (() => T | Promise<T>) | Promise<T>): Promise<T> =>
  typeof v === "function" ? (v as () => T | Promise<T>)() : v;

function captureWarnings<T>(run: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: run(), warnings };
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

const configText = (bundles: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ bundles, ...extra });

describe("bundles.*.path", () => {
  test("`~` expands to the home directory", () => {
    const { value } = captureWarnings(() =>
      parseAndValidateConfigText(configText({ a: { path: "~/akm-bundle-a/" } }), "/etc/akm/config.json"),
    );
    expect(value.bundles?.a?.path).toBe(path.join(os.homedir(), "akm-bundle-a"));
  });

  test("a relative path means the config file's folder, not the cwd", () => {
    const { value } = captureWarnings(() =>
      parseAndValidateConfigText(configText({ a: { path: "../bundles/a" } }), "/srv/akm/config.json"),
    );
    expect(value.bundles?.a?.path).toBe("/srv/bundles/a");
  });

  test("a relative path with no config file to resolve against warns once and drops that bundle", () => {
    const { value, warnings } = captureWarnings(() =>
      parseAndValidateConfigText(configText({ a: { path: "rel/a" }, b: { path: "/abs/b" } })),
    );
    expect(Object.keys(value.bundles ?? {})).toEqual(["b"]);
    expect(warnings.filter((w) => w.includes("bundles.a"))).toHaveLength(1);
  });
});

describe("akm migrate apply keeps bundles as written", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());
  const configPath = () => path.join(storage.configDir, "akm", "config.json");

  test("`~/x` stays `~/x`, an unplaceable bundle stays in the file", () => {
    const bundles = { a: { path: "~/x" }, bad: { path: "~nobody/y" } };
    fs.writeFileSync(configPath(), JSON.stringify({ bundles }));
    const { warnings } = captureWarnings(() => normalizeConfigFile(configPath(), { apply: true }));
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(configPath(), "utf8")).bundles).toEqual(bundles);
  });

  test("a healthy file reports current", () => {
    fs.writeFileSync(configPath(), JSON.stringify({ bundles: { a: { path: "~/x" }, b: { path: "/abs/b/" } } }));
    const result = normalizeConfigFile(configPath(), { apply: false });
    expect(result.keys).not.toContain("bundles");
  });
});

describe("resolveConfiguredBundlePath", () => {
  test("places `~`, absolute and config-relative paths, and refuses the rest", () => {
    expect(resolveConfiguredBundlePath("~", "/c/config.json")).toBe(os.homedir());
    expect(resolveConfiguredBundlePath("~/x", undefined)).toBe(path.join(os.homedir(), "x"));
    expect(resolveConfiguredBundlePath("/a/b/", undefined)).toBe("/a/b");
    expect(resolveConfiguredBundlePath("x", "/c/config.json")).toBe("/c/x");
    expect(resolveConfiguredBundlePath("x", undefined)).toBeUndefined();
    expect(resolveConfiguredBundlePath("~other/x", "/c/config.json")).toBeUndefined();
  });
});

describe("strict integer flags", () => {
  test("parseIntegerFlag rejects trailing junk, decimals, negatives and out-of-range values", () => {
    for (const raw of ["3x", "3.5", "-1", "", " 3", "0"]) {
      expect(() => parseIntegerFlag(raw, "--n", 1)).toThrow(UsageError);
    }
    expect(parseIntegerFlag("0", "--n", 0)).toBe(0);
    expect(parseIntegerFlag("12", "--n", 1)).toBe(12);
    expect(parseIntegerFlag(undefined, "--n", 1)).toBeUndefined();
    expect(() => parseIntegerFlag("9", "--n", 1, 8)).toThrow(UsageError);
  });

  test("`proposal accept --older-than 3x` is rejected like `improve --limit 3x`", async () => {
    const result = await runCliCapture(["proposal", "accept", "--generator", "g", "--older-than", "3x", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--older-than");
  });

  test("`proposal reject --max-diff-lines 5x` is rejected", async () => {
    const result = await runCliCapture([
      "proposal",
      "reject",
      "--generator",
      "g",
      "--reason",
      "r",
      "--max-diff-lines",
      "5x",
      "--dry-run",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--max-diff-lines");
  });

  test("`proposal extract --timeout-ms 5x` is rejected", async () => {
    const result = await runCliCapture(["proposal", "extract", "--type", "x", "--timeout-ms", "5x"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--timeout-ms");
  });

  test("`workflow run --max-retries 1x` is rejected", async () => {
    const result = await runCliCapture(["workflow", "run", "x", "--max-retries", "1x"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--max-retries");
  });
});

describe("workflow run --shape", () => {
  test("is an ordinary workflow parameter, not a reserved flag", () => {
    expect(parseWorkflowParameterFlags(["wf", "--shape", "agent"], "wf")).toEqual([{ name: "shape", value: "agent" }]);
  });
});

describe("one duration grammar", () => {
  const now = 1_700_000_000_000;
  test("`proposal extract --since`: `m` is minutes and `M` is months, as for health and remember", () => {
    expect(parseSinceArg("5m", now)).toBe(now - 5 * 60_000);
    expect(parseSinceArg("3M", now)).toBe(now - 3 * 30 * 86_400_000);
  });

  test("`--since 24H` typed on the command line is a usage error", () => {
    for (const bad of ["24H", "7D", "5 m"]) expect(() => parseSinceArg(bad, now)).toThrow(UsageError);
  });
});

describe("remember --show-similar", () => {
  test("--help advertises one spelling that works, and the camelCase one still parses", async () => {
    const remember = await resolveValue((main as { subCommands?: unknown }).subCommands as never);
    const command = await resolveValue((remember as Record<string, unknown>).remember as never);
    const usage = await renderUsage(command as never);
    expect(usage).toContain("--show-similar");
    expect(usage).not.toContain("-showSimilar");
    const parsed = parseArgs(["--showSimilar"], (command as { args: never }).args) as Record<string, unknown>;
    expect(parsed.showSimilar).toBe(true);
  });
});

describe("gone flags", () => {
  test("`improve --auto-accept` names its replacement", () => {
    try {
      assertKnownFlags(main as unknown as FlagScanCommand, ["improve", "--auto-accept", "90"]);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const hint = (err as UsageError).hint() ?? "";
      expect(hint).toContain("`--auto-accept` is gone");
      expect(hint).toContain("akm proposal drain --promote --yes");
    }
  });

  const hintFor = (argv: string[]): string => {
    try {
      assertKnownFlags(main as unknown as FlagScanCommand, argv);
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("UNKNOWN_FLAG");
      return (err as UsageError).hint() ?? "";
    }
    throw new Error("expected a rejection");
  };

  test.each([
    [["improve", "--require-engines"], "`--require-engines` is gone", "akm health && akm improve"],
    [["workflow", "list", "--all-scopes"], "`--all-scopes` is gone", "drop it"],
    [["workflow", "status", "r1", "--all-scopes"], "`--all-scopes` is gone", "drop it"],
    [["bundle", "add", "x", "--allow-dangerous-env-keys"], "`--allow-dangerous-env-keys` is gone", "drop it"],
    [["bundle", "update", "--allow-dangerous-env-keys"], "`--allow-dangerous-env-keys` is gone", "drop it"],
    [["env", "run", "--allow-dangerous-env-keys"], "`--allow-dangerous-env-keys` is gone", "drop it"],
    [["bundle", "update", "--yes"], "`--yes` is gone", "drop it"],
    [["registry", "add", "http://x", "--options", "{}"], "`--options` is gone", "drop it"],
    [["task", "sync", "--dry-run"], "`--dry-run` is gone", "akm migrate status"],
    [["task", "sync", "--bundle", "b"], "`--bundle` is gone", "drop it"],
    [["task", "add", "--rebind"], "`--rebind` is gone", "drop it"],
    [["task", "history", "--id", "t1"], "`--id` is gone", "akm task history <id>"],
    [["lint", "--auto-fix"], "`--auto-fix` is gone", "use `--fix`"],
    [["migrate", "apply", "--dry-run"], "`--dry-run` is gone", "use `akm migrate status`"],
    [["bundle", "update", "--yes"], "`--yes` is gone: it did nothing, so drop it.", "drop it"],
    [["setup", "--probe"], "`--probe` is gone: probing is the default", "--no-probe"],
  ])("%j names its replacement", (argv, gone, use) => {
    const hint = hintFor(argv);
    expect(hint).toContain(gone);
    expect(hint).toContain(use);
  });

  test.each([
    [["bundle", "list", "--yes"]],
    [["workflow", "list", "--id", "x"]],
    [["workflow", "list", "--rebind"]],
    [["registry", "list", "--dry-run"]],
    [["bundle", "list", "--options", "x"]],
  ])("%j is unknown but not a gone flag where the name is scoped elsewhere", (argv) => {
    expect(hintFor(argv)).not.toContain("is gone");
  });
});

describe("GITHUB_TOKEN set but empty", () => {
  test("does not hide GH_TOKEN", () => {
    const headers = withEnvSync({ GITHUB_TOKEN: "", GH_TOKEN: "ghs_from_gh_token" }, () => githubHeaders()) as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer ghs_from_gh_token");
  });
});

describe("readStashDirFromConfig", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage({}, { bundle: false });
  });
  afterEach(() => storage.cleanup());

  test("a relative default bundle path means the config file's folder, not the cwd", () => {
    const bundleDir = path.join(storage.configDir, "akm", "my-bundle");
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(
      path.join(storage.configDir, "akm", "config.json"),
      JSON.stringify({ defaultBundle: "a", bundles: { a: { path: "my-bundle" } } }),
    );
    expect(resolveStashDir()).toBe(bundleDir);
  });
});

describe("$schema", () => {
  test("is accepted without an unknown-key warning", () => {
    const { warnings } = captureWarnings(() =>
      parseAndValidateConfigText(JSON.stringify({ $schema: "https://example.test/akm-config.json" })),
    );
    expect(warnings.filter((w) => w.includes("$schema"))).toEqual([]);
  });
});

describe("retired-settings warning", () => {
  test("a strategy that says where a process runs is not blamed on a models.json that does not exist", () => {
    const text = JSON.stringify({
      connections: { lab: { endpoint: "http://lab.example.test/v1" } },
      improve: { strategies: { mine: { processes: { reflect: { connection: "lab" } } } } },
    });
    const { warnings } = captureWarnings(() => parseAndValidateConfigText(text, "/etc/akm/config.json"));
    const retired = warnings.filter((w) => w.includes("retired"));
    expect(retired).toHaveLength(1);
    expect(retired[0]).not.toContain("models.json");
  });
});
