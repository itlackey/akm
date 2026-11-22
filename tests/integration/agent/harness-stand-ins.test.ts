// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What each harness's program receives, read from a stand-in program per harness that records what it was started
 * with: a prompt of any size arrives whole, a model arrives once and replaces an authored one, and a launch with no
 * prompt carries no prompt. The command line is checked only through what the program got, never as an argument list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { buildExecution, currentLayer, resolveExecution } from "../../../src/integrations/agent/execution";
import { executeInteractiveAgentInvocation, runExecution } from "../../../src/integrations/agent/runner-dispatch";
import { HARNESS_CONFIG_PLATFORMS, HARNESS_REGISTRY } from "../../../src/integrations/harnesses";
import { harnessCalls, promptOf, writeFakeHarness } from "../../_helpers/engine-stubs";
import { fakeOpencodeMajor } from "../../_helpers/opencode-version";
import { makeSandboxDir, type SandboxedDir } from "../../_helpers/sandbox";

let bins: SandboxedDir;
beforeEach(() => {
  fakeOpencodeMajor(1);
  bins = makeSandboxDir("akm-harness-stand-ins");
});
afterEach(() => bins.cleanup());

const LARGE_PROMPT = `${"a long prompt line, to be read whole\n".repeat(6000)}END-OF-THE-LARGE-PROMPT`;

/** The harness whose model is carried by its environment, so an authored `--model` is no model of its own. */
const MODEL_BY_ENVIRONMENT = ["openhands"];

/** A harness that takes its prompt only as a command-line argument cannot be given more than the kernel allows one argument. */
const PROMPT_ON_THE_COMMAND_LINE = ["copilot", "gemini", "aider", "amazonq", "openhands"];

function configFor(platform: string, bin: string, args: string[] = []): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    harnesses: { standin: { platform, bin, args } },
  } as AkmConfig;
}

/** Runs one dispatch on the stand-in for `platform`, and returns what the program recorded. */
async function dispatch(
  platform: string,
  prompt: string,
  options: { model?: string; args?: string[] } = {},
): Promise<{
  ok: boolean;
  reason: string | undefined;
  error: string | undefined;
  call: ReturnType<typeof harnessCalls>[number] | undefined;
}> {
  const bin = writeFakeHarness(bins.dir, `standin-${platform}`, ["done"]);
  const resolved = resolveExecution({
    content: prompt,
    config: configFor(platform, bin, options.args),
    layers: [currentLayer({ harness: "standin", ...(options.model ? { model: options.model } : {}) })],
    modelWork: false,
  });
  const result = await runExecution(buildExecution(resolved.request, resolved.runner));
  return { ok: result.ok, reason: result.reason, error: result.error, call: harnessCalls(bin)[0] };
}

/** Every place the program was given text: its arguments, its input, and its environment values. */
const everything = (call: ReturnType<typeof harnessCalls>[number] | undefined): string =>
  [...(call?.argv ?? []), call?.stdin ?? "", ...Object.values(call?.env ?? {})].join("\n");

describe("the harnesses akm starts", () => {
  test("every registered harness is covered here", () => {
    const covered: string[] = [...HARNESS_CONFIG_PLATFORMS];
    expect(covered.sort()).toEqual(HARNESS_REGISTRY.map((h) => String(h.id)).sort());
  });

  describe.each([...HARNESS_CONFIG_PLATFORMS].map((platform) => [platform]))("%s", (platform) => {
    test("a short prompt reaches the program whole", async () => {
      const { call } = await dispatch(platform, "do the short work");
      expect(everything(call)).toContain("do the short work");
    });

    test.skipIf(PROMPT_ON_THE_COMMAND_LINE.includes(platform))(
      "a prompt over 128 KB reaches the program whole",
      async () => {
        const { call } = await dispatch(platform, LARGE_PROMPT);
        expect(promptOf(call)).toContain(LARGE_PROMPT);
      },
    );

    test("a model is passed once, and replaces one the harness's own args name", async () => {
      const authored = MODEL_BY_ENVIRONMENT.includes(platform) ? [] : ["--model", "model-old"];
      const { call } = await dispatch(platform, "work", { model: "model-new", args: authored });
      const text = everything(call);
      expect(text).not.toContain("model-old");
      expect(text.split("model-new")).toHaveLength(2);
    });

    test("a launch with no prompt gives the program none", async () => {
      const bin = writeFakeHarness(bins.dir, `interactive-${platform}`, [""], { readStdin: false });
      await executeInteractiveAgentInvocation({ config: configFor(platform, bin), harness: "standin" });
      const [call] = harnessCalls(bin);
      expect(call).toBeDefined();
      expect(everything(call)).not.toContain("--prompt");
      expect(call?.stdin).toBe("");
    });
  });
});

describe("a prompt over 128 KB, for a harness that takes it only as a command-line argument", () => {
  test.each(
    PROMPT_ON_THE_COMMAND_LINE,
  )("%s: akm reports that it cannot start the program with it, and starts nothing on a cut prompt", async (platform) => {
    const { ok, reason, error, call } = await dispatch(platform, LARGE_PROMPT);
    expect(ok).toBe(false);
    expect(reason).toBe("spawn_failed");
    expect(error).toContain("command line");
    expect(call).toBeUndefined();
  });
});
