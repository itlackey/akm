// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A harness's reply is its stdout, as it printed it, for every command that
 * dispatches one: `akm agent --prompt` and `akm command run` print the reply
 * (text, not an event stream or an envelope of the harness's own), and what the
 * harness writes on stderr stays on stderr. For OpenCode 1 the reply is read from
 * the event stream akm asked for (`--format json`), as the text OpenCode prints in
 * its default format. Integration: it spawns a fake CLI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmIndex } from "../../../src/indexer/indexer";
import { runCliCapture } from "../../_helpers/cli";
import { harnessCalls, writeFakeHarness } from "../../_helpers/engine-stubs";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const REPLY = "The review is done.\n\nTwo findings:\n- one\n- two";
/** Looks like a harness's JSON event stream; it is the reply, so it must come back untouched. */
const JSON_LOOKING_REPLY = '{"type":"result","result":"not an envelope","session_id":"s-1"}';
const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/opencode1-run");
const PROGRESS = "thinking...\nrunning tools...\n";
/** What OpenCode 2.2.0's headless `run` prints on stderr when it refuses a read outside its directory (measured). */
const REFUSED =
  "! permission requested: external_directory (/elsewhere/*); auto-rejecting\n" +
  "✗ Read /elsewhere/data.json failed\n" +
  "Error: This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.\n";

let storage: IsolatedAkmStorage;
let bins: SandboxedDir;

const bundleConfig = (stashDir: string) => ({
  semanticSearchMode: "off" as const,
  defaultBundle: "fixture",
  bundles: { fixture: { path: stashDir, adapter: "akm" } },
});

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-harness-reply-bin");
  writeSandboxConfig(bundleConfig(storage.stashDir));
  fs.writeFileSync(
    path.join(storage.stashDir, "commands", "review.md"),
    "---\nname: review\ntype: command\nupdated: 2026-08-19\n---\nReview exactly: [$ARGUMENTS]\n",
  );
  fs.mkdirSync(path.join(storage.stashDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "agents", "reader.md"), "---\ntype: agent\n---\nA careful reader.\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
});

afterEach(() => {
  bins.cleanup();
  storage.cleanup();
});

/** Configure `platform` on a fake harness that answers `reply` on stdout and `PROGRESS` on stderr. */
function harness(platform: string, reply: string): string {
  const bin = writeFakeHarness(bins.dir, `fake-${platform}`, [reply], { stderr: PROGRESS });
  writeSandboxConfig({ ...bundleConfig(storage.stashDir), harnesses: { [platform]: { platform, bin } } });
  return bin;
}

describe.each(["codex", "claude", "gemini"])("a %s harness's reply", (platform) => {
  test("akm agent --prompt prints the reply as the harness wrote it, and its progress stays on stderr", async () => {
    const bin = harness(platform, REPLY);

    const result = await runCliCapture(["agent", "--prompt", "say hello", "--format=json"]);

    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; stdout: string; stderr: string };
    expect(envelope).toMatchObject({ ok: true, stdout: `${REPLY}\n`, stderr: PROGRESS });
    // The harness was asked for plain text.
    const [call] = harnessCalls(bin);
    expect(call?.argv.join(" ")).not.toMatch(/--json|--output-format|--mode json/);
  });

  test("akm command run prints the reply as the harness wrote it", async () => {
    harness(platform, REPLY);

    const result = await runCliCapture([
      "command",
      "run",
      "commands/review",
      "--arguments",
      "the diff",
      "--format=json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, stdout: `${REPLY}\n`, stderr: PROGRESS });
  });
});

describe("a reply that looks like a harness's own JSON", () => {
  test("is the reply: nothing unwraps it, and no session id is read out of it", async () => {
    harness("claude", JSON_LOOKING_REPLY);

    const result = await runCliCapture(["agent", "--prompt", "say hello", "--format=json"]);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.stdout).toBe(`${JSON_LOOKING_REPLY}\n`);
    expect(envelope).not.toHaveProperty("sessionId");
  });
});

/**
 * A fake `opencode` that reports `version` for `--version`, and otherwise prints `stdout` (a file's bytes, or nothing)
 * on stdout and `stderr` on stderr and exits `exitCode`.
 */
function fakeOpencode(version: string, options: { stdout?: string; stderr?: string; exitCode?: number } = {}): string {
  const bin = path.join(bins.dir, "opencode");
  const out = options.stdout ? `cat ${JSON.stringify(path.join(FIXTURES, options.stdout))}` : "true";
  const err = options.stderr ? `printf %b ${JSON.stringify(options.stderr)} >&2` : "true";
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nprintf '%s\\n' "$@" > "$0.argv"\ncat >/dev/null\n${out}\n${err}\nexit ${options.exitCode ?? 0}\n`,
    { mode: 0o755 },
  );
  writeSandboxConfig({ ...bundleConfig(storage.stashDir), harnesses: { opencode: { platform: "opencode", bin } } });
  return bin;
}

const runReader = (...extra: string[]) =>
  runCliCapture(["run", "agents/reader", "--prompt", "Read /etc/hostname.", ...extra, "--format=json"]);

describe("an agent that ends with no reply", () => {
  test("has failed though it exits 0: OpenCode 2 refused the read outside --cwd and said nothing", async () => {
    fakeOpencode("2.2.0", { stderr: REFUSED });
    const work = makeSandboxDir("akm-harness-reply-work");
    try {
      const result = await runReader("--cwd", work.dir);

      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        exitCode: 0,
        reason: "parse_error",
        error: '"opencode" returned no answer.',
        stderr: REFUSED,
      });
    } finally {
      work.cleanup();
    }
  });
});

describe("an OpenCode 1 turn that ended on a refused tool call", () => {
  // OpenCode 1.18.25 exits 0 and prints one sentence; only its event stream says the turn did not finish.
  test("has failed: the error names OpenCode's finish reason and the failed tool, the reply and session id are kept", async () => {
    const bin = fakeOpencode("1.18.25", { stdout: "oc1-json.out" });

    const result = await runReader();

    expect(result.code).not.toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      exitCode: 0,
      reason: "parse_error",
      stdout: "I will read the file now.\n",
      sessionId: "ses_e015daf81ffeBDYwsN7qEcmDWR",
    });
    expect(envelope.error).toContain("The user rejected permission to use this specific tool call.");
    expect(envelope.error).toContain("tool-calls");
    // The event stream was asked for.
    expect(fs.readFileSync(`${bin}.argv`, "utf8")).toBe("run\n--format\njson\n");
  });

  test("a finished two-step turn is the reply OpenCode's default format prints, with its session id", async () => {
    fakeOpencode("1.18.25", { stdout: "oc1-ok.out" });

    const result = await runReader();

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      stdout: fs.readFileSync(path.join(FIXTURES, "oc1-ok-default.out"), "utf8"),
      sessionId: "ses_e0158baa0ffeiFP4KIeXxevgRX",
    });
  });

  test("a provider error exits non-zero and OpenCode's message, which the stream carries on stdout, is in the error", async () => {
    fakeOpencode("1.18.25", { stdout: "oc1-error.out", exitCode: 1 });

    const result = await runReader();

    expect(result.code).not.toBe(0);
    const envelope = JSON.parse(result.stdout) as { reason: string; error: string };
    expect(envelope.reason).toBe("non_zero_exit");
    expect(envelope.error.endsWith(": fake provider refused the request")).toBe(true);
  });
});
