/**
 * `remember --enrich`'s model call (`runLlmEnrich`): it is bounded by its own
 * 10 s timeout, which rides on the request like any other call's, and a failed
 * call writes the memory without enrichment and says why.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runLlmEnrich } from "../src/commands/remember";
import { _setWarnSinkForTests } from "../src/core/warn";
import { _setChatCompletionForTests, LlmCallError } from "../src/llm/client";
import { sandboxXdgConfigHome, writeSandboxConfig } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

let restoreConfigEnv: (() => void) | undefined;
let warnings: string[] = [];

beforeEach(() => {
  restoreConfigEnv = sandboxXdgConfigHome().cleanup;
  writeSandboxConfig({
    connections: { enrich: { endpoint: "http://localhost:1/v1", models: { fast: "m" } } },
    improve: { connection: "enrich" },
  });
  warnings = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  restoreConfigEnv?.();
  restoreConfigEnv = undefined;
});

describe("runLlmEnrich", () => {
  test("the call carries its 10 s timeout, and the reply becomes tags and a description", async () => {
    let timeoutMs: number | null | undefined;
    overrideSeam(_setChatCompletionForTests, async (_config, _messages, options) => {
      timeoutMs = options?.timeoutMs;
      return '{"tags":["ops"],"description":"Deploys need the VPN.","observed":"2026-04-24"}';
    });

    const result = await runLlmEnrich("Deploys need the VPN.");

    expect(timeoutMs).toBe(10_000);
    expect(result).toMatchObject({ tags: ["ops"], description: "Deploys need the VPN.", observed_at: "2026-04-24" });
    expect(warnings).toEqual([]);
  });

  test("a failed call writes without enrichment and says why", async () => {
    overrideSeam(_setChatCompletionForTests, async () => {
      throw new LlmCallError("Request timed out after 10000ms", "timeout");
    });

    const result = await runLlmEnrich("Deploys need the VPN.");

    expect(result.tags).toEqual([]);
    expect(warnings).toEqual([
      "Warning: --enrich failed (Request timed out after 10000ms). Writing memory without enrichment.",
    ]);
  });
});
