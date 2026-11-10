// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { buildProposePrompt, PROPOSAL_JSON_SCHEMA } from "../src/commands/prompts";
import { type AkmProposeOptions, akmPropose } from "../src/commands/proposal/propose";
import { listProposals } from "../src/commands/proposal/repository";
import type { AkmConfig } from "../src/core/config/config";
import { formatProposalShowPlain } from "../src/output/text/helpers";
import { installFakeOpencodeRuntime } from "./_helpers/fake-opencode-runtime";
import { fakeOpencodeMajor } from "./_helpers/opencode-version";
import { makeStashDir, mutateScopedEnv, type SandboxedDir, withEnv } from "./_helpers/sandbox";

// Pins the warn-vs-error rendering of `akm proposal show` plain text (#557).
// `severity: "warn"` findings are non-blocking and must read as advisory
// (yellow `⚠ warning ... (non-blocking)`), visually distinct from blocking
// errors (red `✗ error`). The JSON shape is unchanged — these tests only
// assert the text renderer.

const baseProposal = {
  id: "uuid-1",
  ref: "lessons/rg-over-grep",
  status: "pending",
  source: "distill",
};

describe("formatProposalShowPlain — severity rendering (#557)", () => {
  it("renders a warn-only proposal as valid with a non-blocking warning", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: {
        ok: true,
        findings: [{ kind: "invalid-description", message: "description starts with 'When'", severity: "warn" }],
      },
    });
    expect(out).toContain("✓ valid (1 warning(s))");
    expect(out).toContain("⚠ warning  [invalid-description] description starts with 'When' (non-blocking)");
    // Must NOT render the warn finding with the blocking-error icon/label.
    expect(out).not.toContain("✗ error");
    expect(out).not.toContain("✗ invalid");
  });

  it("renders a blocking error as invalid with the error icon", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: {
        ok: false,
        findings: [{ kind: "missing-field", message: "ref is required" }],
      },
    });
    expect(out).toContain("✗ invalid (1 error(s))");
    expect(out).toContain("✗ error  [missing-field] ref is required");
    expect(out).not.toContain("⚠ warning");
  });

  it("distinguishes errors from warnings when both are present (errors first)", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: {
        ok: false,
        findings: [
          { kind: "invalid-description", message: "starts with 'When'", severity: "warn" },
          { kind: "missing-field", message: "ref is required" },
        ],
      },
    });
    expect(out).toContain("✗ invalid (1 error(s), 1 warning(s))");
    const errorIdx = out.indexOf("✗ error  [missing-field]");
    const warnIdx = out.indexOf("⚠ warning  [invalid-description]");
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    // Blocking errors render before advisory warnings.
    expect(errorIdx).toBeLessThan(warnIdx);
  });

  it("renders a clean proposal as valid with no findings", () => {
    const out = formatProposalShowPlain({
      proposal: baseProposal,
      validation: { ok: true, findings: [] },
    });
    expect(out).toContain("✓ valid");
    expect(out).not.toContain("warning");
    expect(out).not.toContain("✗ error");
  });
});

describe("proposal-execution-lowering", () => {
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
      semanticSearchMode: "auto",
      bundles: { work: { path: stashDir, writable: true } },
      defaultBundle: "work",
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
      const host = installFakeOpencodeRuntime({
        reply: () =>
          proposalReply("skills/lowered", "Exercises resolved proposal lowering", "Use the shared boundary."),
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
      expect(call?.model).toBe("provider/exact-proposal-092");
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
      installFakeOpencodeRuntime({
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
      const host = installFakeOpencodeRuntime({
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
      expect(host.calls[0]?.authorization).toBe(`Bearer ${replacement}`);
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
      const host = installFakeOpencodeRuntime({
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

      expect(host.calls[0]?.authorization).toBe(`Bearer ${secret}`);
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
});
