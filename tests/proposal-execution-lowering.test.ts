// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { type AkmProposeOptions, akmPropose } from "../src/commands/proposal/propose";
import { listProposals } from "../src/commands/proposal/repository";
import type { AkmConfig } from "../src/core/config/config";
import { buildProposePrompt, PROPOSAL_JSON_SCHEMA } from "../src/integrations/agent/prompts";
import { __setTestServer, closeServer } from "../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { makeStashDir, mutateScopedEnv, type SandboxedDir, withEnv, withMockedFetch } from "./_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];

afterEach(async () => {
  await closeServer();
  for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

function proposalStash(): string {
  const sandbox = makeStashDir();
  sandboxes.push(sandbox);
  return sandbox.dir;
}

function directConfig(stashDir: string, apiKey?: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    bundles: { work: { path: stashDir, writable: true } },
    defaultBundle: "work",
    defaultWriteTarget: "work",
    engines: {
      direct: {
        kind: "llm",
        endpoint: "https://proposal.invalid/v1/chat/completions",
        model: "provider/exact-proposal-092",
        temperature: 0.17,
        maxTokens: 222,
        contextLength: 16_384,
        enableThinking: false,
        extraParams: { seed: 92 },
        ...(apiKey ? { apiKey } : {}),
      },
    },
  } as AkmConfig;
}

function sdkFallbackConfig(stashDir: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    bundles: { work: { path: stashDir, writable: true } },
    defaultBundle: "work",
    defaultWriteTarget: "work",
    engines: {
      sdk: {
        kind: "agent",
        platform: "opencode-sdk",
        bin: "/not-used/opencode",
        llmEngine: "sdk-fallback",
      },
      "sdk-fallback": {
        kind: "llm",
        endpoint: "https://sdk-fallback.invalid/v1/chat/completions",
        model: "provider/exact-sdk-fallback-model",
        apiKey: "$PROPOSAL_SDK_FALLBACK_KEY",
      },
    },
  } as AkmConfig;
}

describe("proposal consumers lower resolved execution requests", () => {
  test("proposal new sends exact live fields, the proposal prompt and its JSON Schema", async () => {
    const stashDir = proposalStash();
    let requestBody: Record<string, unknown> | undefined;

    const result = await withMockedFetch(
      () =>
        akmPropose({
          type: "skill",
          name: "lowered",
          task: "AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES",
          engine: "direct",
          timeoutMs: 2_000,
          stashDir,
          agentConfig: directConfig(stashDir),
        }),
      (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ref: "skills/lowered",
                  content: "---\ndescription: Exercises resolved proposal lowering\n---\n\nUse the shared boundary.\n",
                }),
              },
            },
          ],
        });
      },
    );

    expect(result.ok).toBe(true);
    expect(result.engine).toBe("direct");
    expect(requestBody).toMatchObject({
      model: "provider/exact-proposal-092",
      temperature: 0.17,
      max_tokens: 222,
      enable_thinking: false,
      seed: 92,
      response_format: { type: "json_schema", json_schema: { schema: PROPOSAL_JSON_SCHEMA } },
    });
    expect(requestBody?.messages).toEqual([
      {
        role: "user",
        content: buildProposePrompt({
          type: "skill",
          name: "lowered",
          task: "AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES",
        }),
      },
    ]);
    expect(requestBody).not.toHaveProperty("tools");
    const notices = (result as typeof result & { notices?: Array<Record<string, unknown>> }).notices ?? [];
    expect(JSON.stringify(notices)).not.toContain("AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES");
    expect(JSON.stringify(notices)).not.toContain("proposal.invalid");
  });

  test("proposal failure returns the centrally redacted direct-LLM envelope", async () => {
    const stashDir = proposalStash();
    const secret = "proposal-consumer-secret";
    const result = await withEnv({ PROPOSAL_TEST_KEY: secret }, () =>
      withMockedFetch(
        () =>
          akmPropose({
            type: "skill",
            name: "provider-failure",
            task: "Keep provider failures secret-free",
            engine: "direct",
            stashDir,
            agentConfig: directConfig(stashDir, "$PROPOSAL_TEST_KEY"),
          }),
        () => {
          throw new Error(`provider body echoed ${secret}`);
        },
      ),
    );

    expect(result).toMatchObject({ ok: false, reason: "spawn_failed", engine: "direct" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.notices).toBeUndefined();
  });

  test("proposal dispatch reads the credential at dispatch, after the preflight", async () => {
    const stashDir = proposalStash();
    const secret = "proposal-lease-original-092";
    const replacement = "proposal-lease-replacement-092";
    let dispatchReady = false;
    let authorization: string | null = null;
    const options = {
      type: "skill",
      name: "lease-bound",
      task: "Keep the operation credential stable.",
      engine: "direct",
      stashDir,
      agentConfig: directConfig(stashDir, "$PROPOSAL_LEASE_KEY"),
      onDispatchReady: () => {
        dispatchReady = true;
        mutateScopedEnv("PROPOSAL_LEASE_KEY", replacement);
      },
    } as AkmProposeOptions & { onDispatchReady: () => void };

    const result = await withEnv({ PROPOSAL_LEASE_KEY: secret }, () =>
      withMockedFetch(
        () => akmPropose(options),
        (_url, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ref: "skills/lease-bound",
                    content: "---\ndescription: Lease-bound proposal\n---\n\nUse the operation snapshot.\n",
                  }),
                },
              },
            ],
          });
        },
      ),
    );

    expect(dispatchReady).toBe(true);
    expect(authorization as string | null).toBe(`Bearer ${replacement}`);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(replacement);
  });

  test("SDK replies that echo a symbolic fallback credential are rejected instead of persisting redacted text", async () => {
    const stashDir = proposalStash();
    const secret = "proposal-sdk-fallback-secret-092";
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "proposal-sdk-session" } }),
          prompt: async () => {
            const content = `---\ndescription: SDK fallback proposal\n---\n\nThe provider echoed ${secret}.\n`;
            const reply = JSON.stringify({ ref: "skills/sdk-fallback-redaction", content });
            return { data: { parts: [{ type: "text", text: reply }] } };
          },
          delete: async () => ({}),
        },
      },
      server: { close() {} },
    } as never);

    const result = await withEnv({ PROPOSAL_SDK_FALLBACK_KEY: secret }, () =>
      akmPropose({
        type: "skill",
        name: "sdk-fallback-redaction",
        task: "Author a draft through the frozen SDK fallback.",
        engine: "sdk",
        stashDir,
        agentConfig: sdkFallbackConfig(stashDir),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsafe content rejection");
    expect(result.engine).toBe("sdk");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toMatch(/configured credential|\[REDACTED\]/);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(listProposals(stashDir)).toEqual([]);
  });
});
