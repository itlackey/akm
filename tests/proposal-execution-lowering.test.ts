// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AkmProposeOptions, akmPropose } from "../src/commands/proposal/propose";
import { listProposals } from "../src/commands/proposal/repository";
import type { AkmConfig } from "../src/core/config/config";
import { buildProposePrompt, PROPOSAL_JSON_SCHEMA } from "../src/integrations/agent/prompts";
import { installFakeOpencodeHost } from "./_helpers/fake-opencode-host";
import { fakeOpencodeMajor } from "./_helpers/opencode-version";
import { makeStashDir, mutateScopedEnv, type SandboxedDir, withEnv } from "./_helpers/sandbox";

beforeEach(() => fakeOpencodeMajor(1));

const sandboxes: SandboxedDir[] = [];

afterEach(() => {
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
    connections: {
      direct: {
        endpoint: "https://proposal.invalid/v1/chat/completions",
        models: { fast: "provider/exact-proposal-092" },
        temperature: 0.17,
        max_tokens: 222,
        contextLength: 16_384,
        ...(apiKey ? { apiKey } : {}),
      },
    },
  } as AkmConfig;
}

const proposalReply = (ref: string, description: string, body: string): string =>
  JSON.stringify({ ref, content: `---\ndescription: ${description}\n---\n\n${body}\n` });

describe("proposal new on a connection runs akm's own runtime", () => {
  test("it sends the connection's exact model and request fields, and the proposal prompt", async () => {
    const stashDir = proposalStash();
    const host = installFakeOpencodeHost({
      reply: () => proposalReply("skills/lowered", "Exercises resolved proposal lowering", "Use the shared boundary."),
    });

    const result = await akmPropose({
      type: "skill",
      name: "lowered",
      task: "AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES",
      selection: { connection: "direct" },
      timeoutMs: 2_000,
      stashDir,
      agentConfig: directConfig(stashDir),
    });

    expect(result.ok).toBe(true);
    expect(result.engine).toBe("direct");
    expect(host.calls).toHaveLength(1);
    const call = host.calls[0];
    expect(call?.model).toEqual({
      providerID: expect.stringMatching(/^akm-[0-9a-f]{16}$/),
      id: "provider/exact-proposal-092",
    });
    expect(call?.requestBody).toMatchObject({ temperature: 0.17, max_tokens: 222 });
    expect(call?.prompt).toContain(
      buildProposePrompt({ type: "skill", name: "lowered", task: "AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES" }),
    );
    const notices = (result as typeof result & { notices?: Array<Record<string, unknown>> }).notices ?? [];
    expect(JSON.stringify(notices)).not.toContain("AUTHORING-CONTENT-MUST-NOT-ENTER-NOTICES");
    expect(JSON.stringify(notices)).not.toContain("proposal.invalid");
  });

  test("a failure returns the centrally redacted envelope", async () => {
    const stashDir = proposalStash();
    const secret = "proposal-consumer-secret";
    installFakeOpencodeHost({
      reply: () => ({ error: { type: "provider.unknown", message: `provider body echoed ${secret}` } }),
    });
    const result = await withEnv({ PROPOSAL_TEST_KEY: secret }, () =>
      akmPropose({
        type: "skill",
        name: "provider-failure",
        task: "Keep provider failures secret-free",
        selection: { connection: "direct" },
        stashDir,
        agentConfig: directConfig(stashDir, "$PROPOSAL_TEST_KEY"),
      }),
    );

    expect(result).toMatchObject({ ok: false, engine: "direct" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("the key is read at dispatch, after the preflight", async () => {
    const stashDir = proposalStash();
    const secret = "proposal-lease-original-092";
    const replacement = "proposal-lease-replacement-092";
    let dispatchReady = false;
    const host = installFakeOpencodeHost({
      reply: () => proposalReply("skills/lease-bound", "Lease-bound proposal", "Use the operation snapshot."),
    });
    const options = {
      type: "skill",
      name: "lease-bound",
      task: "Keep the operation credential stable.",
      selection: { connection: "direct" },
      stashDir,
      agentConfig: directConfig(stashDir, "$PROPOSAL_LEASE_KEY"),
      onDispatchReady: () => {
        dispatchReady = true;
        mutateScopedEnv("PROPOSAL_LEASE_KEY", replacement);
      },
    } as AkmProposeOptions & { onDispatchReady: () => void };

    const result = await withEnv({ PROPOSAL_LEASE_KEY: secret }, () => akmPropose(options));

    expect(dispatchReady).toBe(true);
    expect(host.calls[0]?.requestHeaders.authorization).toBe(`Bearer ${replacement}`);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(replacement);
  });

  // The process environment is the one environment for the dispatch and the secrets kept out of the queue.
  test.each([
    ["is accepted, and the proposal is queued", false],
    ["is accepted, and a reply echoing it is refused", true],
  ])("a key set only in the environment %s", async (_case, echo) => {
    const stashDir = proposalStash();
    const secret = "proposal-envsource-only-092";
    const body = echo ? `The provider echoed ${secret}.` : "Use the caller's environment.";
    const host = installFakeOpencodeHost({
      reply: () => proposalReply("skills/envsource-bound", "Proposal bound to the caller's environment", body),
    });
    const result = await withEnv({ PROPOSAL_ENVSOURCE_KEY: secret }, () =>
      akmPropose({
        type: "skill",
        name: "envsource-bound",
        task: "Read the credential from the caller's environment.",
        selection: { connection: "direct" },
        stashDir,
        agentConfig: directConfig(stashDir, "$PROPOSAL_ENVSOURCE_KEY"),
      }),
    );

    expect(host.calls[0]?.requestHeaders.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(result)).not.toContain(secret);
    if (echo) {
      expect(result).toMatchObject({ ok: false, reason: "parse_error", engine: "direct" });
      if (result.ok) throw new Error("expected the echoed credential to be refused");
      expect(result.error).toMatch(/\[REDACTED\]/);
      expect(listProposals(stashDir)).toEqual([]);
    } else {
      expect(result.ok).toBe(true);
      expect(listProposals(stashDir)).toHaveLength(1);
    }
  });
});

// A provider's strict json_schema response format takes only OpenAI-style strict schemas: every property required, no other allowed.
test("the proposal schema is strict", () => {
  const schema = PROPOSAL_JSON_SCHEMA as {
    required: string[];
    properties: Record<string, unknown>;
    additionalProperties: unknown;
  };

  expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  expect(schema.additionalProperties).toBe(false);
});
