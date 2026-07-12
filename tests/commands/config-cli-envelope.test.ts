// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm config` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,code} error envelope on
 * stderr / exit code) for the representative subcommands
 * list/show/get/set/unset/path/enable/disable, proving the extraction of the
 * family from cli.ts into src/commands/config-cli.ts is byte-identical. The
 * `skills.sh` toggle helpers and the `CONFIG_SUBCOMMAND_SET` routing constant
 * moved with the cluster; the leaf handlers were migrated onto
 * `defineJsonCommand`, which emits the same JSON envelope (stdout/stderr/
 * exit-code) as the inline form.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

beforeEach(() => {
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
});

describe("akm config — JSON envelope snapshot (WS6)", () => {
  test("config list: success envelope carries config v2 engine/strategy semantics", async () => {
    const { stdout, status } = await runCli(["--json", "config", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.semanticSearchMode).toBe("off");
    expect(env.configVersion).toBe("0.9.0");
    expect(env.profiles).toBeUndefined();
  });

  test("config show: alias of list uses the same v2 payload shape", async () => {
    const { stdout, status } = await runCli(["--json", "config", "show"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.semanticSearchMode).toBe("off");
    expect(env.configVersion).toBe("0.9.0");
    expect(env.profiles).toBeUndefined();
  });

  test("config get: returns the requested key value", async () => {
    const { stdout, status } = await runCli(["--json", "config", "get", "semanticSearchMode"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env).toBe("off");
  });

  test("config set: persists and dumps the merged config", async () => {
    const { stdout, status } = await runCli(["--json", "config", "set", "semanticSearchMode", "auto"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.semanticSearchMode).toBe("auto");
  });

  test("config set --silent: suppresses the post-write dump (empty stdout, exit 0)", async () => {
    const { stdout, status } = await runCli(["--json", "config", "set", "semanticSearchMode", "auto", "--silent"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("config set: unsupported --layer → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli([
      "--json",
      "config",
      "set",
      "semanticSearchMode",
      "auto",
      "--layer",
      "project",
    ]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
  });

  test("config unset: unsupported --layer → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["--json", "config", "unset", "semanticSearchMode", "--layer", "project"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
  });

  test("config path --all: success envelope carries config/stash/cache/index paths", async () => {
    const { stdout, status } = await runCli(["--json", "config", "path", "--all"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(typeof env.config).toBe("string");
    expect(typeof env.stash).toBe("string");
    expect(typeof env.cache).toBe("string");
    expect(typeof env.index).toBe("string");
  });

  test("config enable: skills.sh toggle returns component + enabled flag", async () => {
    const { stdout, status } = await runCli(["--json", "config", "enable", "skills.sh"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.component).toBe("skills.sh");
    expect(env.enabled).toBe(true);
  });

  test("config disable: skills.sh toggle returns component + enabled=false", async () => {
    const { stdout, status } = await runCli(["--json", "config", "disable", "skills.sh"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.component).toBe("skills.sh");
    expect(env.enabled).toBe(false);
  });

  test("config enable: unsupported target → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["--json", "config", "enable", "nope"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/Unsupported target/);
  });

  // Regression (def-b2-config-group): `validate` and `migrate` are absent from
  // the hand-maintained routing set, so the bare-group default body runs after
  // the subcommand and emits a *second*, spurious `config list` JSON envelope
  // (the object carrying `semanticSearchMode` + `sources`). Neither subcommand
  // dumps the config, so no such envelope may appear on their stdout.
  test("config validate: does not emit a spurious config-list dump", async () => {
    const { stdout } = await runCli(["--json", "config", "validate"]);
    expect(countConfigListDumps(stdout)).toBe(0);
  });

  test("config migrate --dry-run: does not emit a spurious config-list dump", async () => {
    const { stdout } = await runCli(["--json", "config", "migrate", "--dry-run"]);
    expect(countConfigListDumps(stdout)).toBe(0);
  });
});

/**
 * Count how many `config list` JSON envelopes appear on a stream. The dump is
 * the object emitted by `listConfig` — uniquely identified by a top-level
 * `semanticSearchMode` field alongside a `sources` array. Scans every balanced
 * `{…}` object in the text (subcommand output may be plain text intermixed with
 * the spurious JSON) and counts the matches.
 */
function countConfigListDumps(raw: string): number {
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    const end = readBalancedObject(raw, i);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(raw.slice(i, end)) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "semanticSearchMode" in parsed && Array.isArray(parsed.sources)) {
        count++;
      }
    } catch {
      // Not a standalone JSON object at this offset; keep scanning.
    }
    i = end - 1;
  }
  return count;
}

/** Return the index just past the balanced `{…}` starting at `start`, or -1. */
function readBalancedObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
