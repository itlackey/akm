/**
 * P2 harness-adapter integration (plan §"The adapter contract" /
 * §"Capability matrix").
 *
 * Pins the integration invariants for the seven new adapters (codex, copilot,
 * pi, gemini, aider, amazonq, openhands) plus the pre-existing trio:
 *   - every registry entry with `agentDispatch` resolves a command builder
 *     without throwing (the missing-builder ConfigError no longer fires for
 *     codex/gemini/aider);
 *   - the workflow-engine descriptor fields (pattern, structuredOutput,
 *     resume, identityEnv, agentBuilder, resultExtractor) are populated per
 *     the capability matrix;
 *   - `getCommandBuilder` resolves each canonical id to the harness-owned
 *     builder and rejects retired profile aliases.
 */
import { describe, expect, test } from "bun:test";
import { getCommandBuilder } from "../../src/integrations/agent/builders";
import { getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";
import { AGENT_DISPATCH_HARNESSES, getHarness, HARNESS_REGISTRY } from "../../src/integrations/harnesses";

const NEW_ADAPTER_IDS = ["codex", "copilot", "pi", "gemini", "aider", "amazonq", "openhands"] as const;

function requireHarness(id: string) {
  const harness = getHarness(id);
  if (!harness) throw new Error(`harness "${id}" is not registered`);
  return harness;
}

describe("HARNESS_REGISTRY — P2 adapter integration", () => {
  test("every registry entry with agentDispatch has a resolvable builder (no throw)", () => {
    for (const h of AGENT_DISPATCH_HARNESSES.filter((entry) => entry.agentBuilder)) {
      expect(() => getCommandBuilder(h.id)).not.toThrow();
      expect(getCommandBuilder(h.id)).toBeDefined();
    }
  });

  test("every harness-owned agentBuilder is registered only under its canonical id", () => {
    for (const h of HARNESS_REGISTRY) {
      if (!h.agentBuilder) continue;
      expect(getCommandBuilder(h.id)).toBe(h.agentBuilder);
      expect(() => getCommandBuilder(`${h.id}-headless`)).toThrow();
      for (const alias of h.aliases) {
        expect(() => getCommandBuilder(alias)).toThrow();
      }
    }
  });

  test("every registry entry declares the P2 descriptor fields (pattern + structuredOutput)", () => {
    for (const h of HARNESS_REGISTRY) {
      expect(h.pattern).toBeDefined();
      expect(h.structuredOutput).toBeDefined();
    }
  });

  for (const id of NEW_ADAPTER_IDS) {
    test(`"${id}": dispatch-capable local-runner with builder + extractor + builtin profiles`, () => {
      const h = requireHarness(id);
      expect(h.capabilities.agentDispatch).toBe(true);
      expect(h.pattern).toBe("local-runner");
      // The builder is harness-owned and platform-tagged with the canonical id.
      expect(h.agentBuilder).toBeDefined();
      expect(h.agentBuilder?.platform).toBe(id);
      expect(getCommandBuilder(id)).toBe(h.agentBuilder as NonNullable<typeof h.agentBuilder>);
      // The result extractor is wired on the descriptor (native-executor
      // normalization derives from it).
      expect(h.resultExtractor).toBeDefined();
      expect(typeof h.resultExtractor).toBe("function");
      // Canonical internal descriptors exist so named engines can lower.
      expect(getBuiltinAgentProfile(id)).toBeDefined();
      expect(getBuiltinAgentProfile(`${id}-headless`)).toBeUndefined();
    });
  }

  test("structured-output tiers match the capability matrix", () => {
    expect(requireHarness("codex").structuredOutput).toBe("native-schema");
    for (const id of ["copilot", "pi", "gemini", "openhands"]) {
      expect(requireHarness(id).structuredOutput).toBe("native-json");
    }
    for (const id of ["aider", "amazonq"]) {
      expect(requireHarness(id).structuredOutput).toBe("none");
    }
  });

  test("resume support matches the capability matrix", () => {
    // codex resume is the `exec resume <id>` subcommand, not a flag — the
    // flag-shaped seam stays absent (codexResumeArgs covers the argv prefix).
    expect(requireHarness("codex").resume).toBeUndefined();
    expect(requireHarness("copilot").resume).toEqual({ flag: "--resume", takesSessionId: true });
    expect(requireHarness("pi").resume).toEqual({ flag: "--session", takesSessionId: true });
    expect(requireHarness("gemini").resume).toEqual({ flag: "--resume", takesSessionId: true });
    // Q's --resume is a bare, directory-scoped flag (takes no session id).
    expect(requireHarness("amazonq").resume).toEqual({ flag: "--resume", takesSessionId: false });
    // Aider has chat-history files, OpenHands workspace state — no flag.
    expect(requireHarness("aider").resume).toBeUndefined();
    expect(requireHarness("openhands").resume).toBeUndefined();
  });

  test("identity markers: session-id vars on identityEnv, presence-only flags on presenceEnv", () => {
    // Session-id-bearing vars → identityEnv (their VALUES persist as
    // agent_session_id on workflow runs).
    expect([...(requireHarness("copilot").identityEnv ?? [])]).toEqual(["COPILOT_SESSION_ID"]);
    expect([...(requireHarness("pi").identityEnv ?? [])]).toEqual(["PI_SESSION_ID"]);
    // Presence-only flags → presenceEnv (harness inference only). Peer-review
    // regression: CODEX_SANDBOX=seatbelt / GEMINI_CLI=1 carry a sandbox mode /
    // bare flag, never a session id, so they must NOT be on identityEnv.
    expect(requireHarness("codex").identityEnv).toBeUndefined();
    expect([...(requireHarness("codex").presenceEnv ?? [])]).toEqual(["CODEX_SANDBOX"]);
    expect(requireHarness("gemini").identityEnv).toBeUndefined();
    expect([...(requireHarness("gemini").presenceEnv ?? [])]).toEqual(["GEMINI_CLI"]);
    // The matrix lists these as uncertain — no marker is registered.
    for (const id of ["aider", "amazonq", "openhands"]) {
      expect(requireHarness(id).identityEnv).toBeUndefined();
      expect(requireHarness(id).presenceEnv).toBeUndefined();
    }
  });

  test("builtin profile bins match each harness CLI (q is amazonq's binary)", () => {
    expect(getBuiltinAgentProfile("amazonq")?.bin).toBe("q");
    expect(getBuiltinAgentProfile("copilot")?.bin).toBe("copilot");
    expect(getBuiltinAgentProfile("pi")?.bin).toBe("pi");
    expect(getBuiltinAgentProfile("openhands")?.bin).toBe("openhands");
  });
});
