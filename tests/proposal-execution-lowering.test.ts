// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AkmProposeOptions, akmPropose } from "../src/commands/proposal/propose";
import { listProposals } from "../src/commands/proposal/repository";
import type { AkmConfig } from "../src/core/config/config";
import { buildProposePrompt } from "../src/integrations/agent/prompts";
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

function extractProposalDraftPath(prompt: string): string | undefined {
  const prefix = path.join(os.tmpdir(), "akm-propose-");
  const prefixIndex = prompt.indexOf(prefix);
  if (prefixIndex < 0) return undefined;
  const filenameTail = prompt.slice(prefixIndex + prefix.length).match(/^[^\s`"']+\.md/)?.[0];
  return filenameTail ? `${prefix}${filenameTail}` : undefined;
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
  test("proposal new sends exact live fields without changing the legacy user prompt", async () => {
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
    });
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    const content = String(messages[0]?.content);
    expect(content).toContain(path.join(os.tmpdir(), "akm-propose-"));
    const draftFilePath = extractProposalDraftPath(content);
    expect(draftFilePath).toBeDefined();
    expect(messages[0]).toEqual({
      role: "user",
      content: buildProposePrompt({
        type: "skill",
        name: "lowered",
        task: "AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES",
        draftFilePath: draftFilePath as string,
      }),
    });
    expect(requestBody).not.toHaveProperty("response_format");
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

  test("file-written SDK drafts reject a symbolic fallback credential instead of persisting redacted text", async () => {
    const stashDir = proposalStash();
    const secret = "proposal-sdk-fallback-secret-092";
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "proposal-sdk-session" } }),
          prompt: async (args: { body: { parts: Array<{ type: string; text: string }> } }) => {
            const prompt = args.body.parts[0]?.text ?? "";
            expect(prompt).toContain(path.join(os.tmpdir(), "akm-propose-"));
            const draftFilePath = extractProposalDraftPath(prompt);
            if (!draftFilePath) throw new Error("proposal SDK fixture did not receive the draft path");
            fs.writeFileSync(
              draftFilePath,
              `---\ndescription: SDK fallback draft\n---\n\nThe provider echoed ${secret}.\n`,
              "utf8",
            );
            return { data: { parts: [{ type: "text", text: "" }] } };
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
    expect(result.error).toContain("configured credential");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(listProposals(stashDir)).toEqual([]);
  });
});
