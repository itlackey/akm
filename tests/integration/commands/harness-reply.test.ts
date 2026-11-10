// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

/**
 * A harness's reply is its stdout, as it printed it, for every command that
 * dispatches one: `akm agent --prompt` and `akm command` print the reply
 * (text, not an event stream or an envelope of the harness's own), and what the
 * harness writes on stderr stays on stderr. Integration: it spawns a fake CLI.
 */

const REPLY = "The review is done.\n\nTwo findings:\n- one\n- two";
/** Looks like a harness's JSON event stream; it is the reply, so it must come back untouched. */
const JSON_LOOKING_REPLY = '{"type":"result","result":"not an envelope","session_id":"s-1"}';
const PROGRESS = "thinking...\nrunning tools...\n";

let storage: IsolatedAkmStorage;
let bins: SandboxedDir;

const bundleConfig = (stashDir: string) => ({
  semanticSearchMode: "off" as const,
  defaultBundle: "fixture",
  bundles: { fixture: { path: stashDir, components: { main: { root: ".", adapter: "akm" } } } },
});

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-harness-reply-bin");
  writeSandboxConfig(bundleConfig(storage.stashDir));
  fs.writeFileSync(
    path.join(storage.stashDir, "commands", "review.md"),
    "---\nname: review\ntype: command\nupdated: 2026-08-19\n---\nReview exactly: [$ARGUMENTS]\n",
  );
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

  test("akm command prints the reply as the harness wrote it", async () => {
    harness(platform, REPLY);

    const result = await runCliCapture(["command", "commands/review", "--arguments", "the diff", "--format=json"]);

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

describe("harness-cwd", () => {
  /**
   * A harness runs in the directory akm runs it in, and `PWD` names that directory too, as it does for a program a
   * person starts after `cd <dir>`. OpenCode takes its directory from `PWD` before its working directory, so a `PWD`
   * left as the directory akm was started in made an `opencode` harness's shell and file tools work there instead.
   * Integration: it runs `akm agent --cwd` against a fake `opencode` that records the `PWD` and working directory
   * it started with (a shell script would hide the bug: a shell resets a `PWD` that is not its directory).
   */

  let storage: IsolatedAkmStorage;
  let bins: SandboxedDir;
  let work: SandboxedDir;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    bins = makeSandboxDir("akm-harness-cwd-bin");
    work = makeSandboxDir("akm-harness-cwd-work");
  });

  afterEach(() => {
    work.cleanup();
    bins.cleanup();
    storage.cleanup();
  });

  describe("an opencode harness run with --cwd", () => {
    test("starts in that directory and with PWD naming it, not the directory akm was started in", async () => {
      const bin = writeFakeHarness(bins.dir, "opencode", ["done"]);
      writeSandboxConfig({ harnesses: { oc: { platform: "opencode", bin } } });

      const result = await runCliCapture(["agent", "--prompt", "work", "--harness", "oc", "--cwd", work.dir]);

      expect(result.code).toBe(0);
      const [call] = harnessCalls(bin);
      expect(fs.realpathSync(call?.cwd ?? "")).toBe(fs.realpathSync(work.dir));
      expect(call?.env.PWD).toBe(work.dir);
    });
  });
});
