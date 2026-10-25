// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The harness registry (#562, #1095): the single source of truth that the
 * config schema, the built-in profiles, request lowering, setup, session logs
 * and the docs table derive from. Adding a harness (one folder under
 * `src/integrations/harnesses/` plus one registry line) is complete when this
 * file passes without edits.
 */
import { describe, expect, it, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkHarnessDocsDrift } from "../scripts/gen-config-schema";
import { validateConfigShape } from "../src/core/config/config-schema";
import { VALID_HARNESS_IDS as CONFIG_VALID_HARNESS_IDS } from "../src/core/config/config-types";
import { getBuiltinAgentProfile } from "../src/integrations/agent/profiles";
import {
  getHarness,
  HARNESS_BY_ID,
  HARNESS_NATIVE_AGENT_IDS,
  HARNESS_REGISTRY,
  SESSION_LOG_HARNESSES,
  VALID_HARNESS_IDS,
} from "../src/integrations/harnesses";

const HARNESS_DIR = path.resolve(import.meta.dir, "..", "src", "integrations", "harnesses");

// The pre-unification pair leads the registry: the generated JSON-schema enum
// order must not change. Everything after is appended.
const LEGACY_PREFIX = ["opencode", "claude"];

function requireHarness(id: string) {
  const harness = getHarness(id);
  if (!harness) throw new Error(`harness "${id}" is not registered`);
  return harness;
}

describe("HARNESS_REGISTRY membership", () => {
  it("keeps the legacy pair first so the schema enum order is stable", () => {
    expect(HARNESS_REGISTRY.slice(0, LEGACY_PREFIX.length).map((h) => h.id as string)).toEqual(LEGACY_PREFIX);
  });

  it("HARNESS_BY_ID resolves every canonical id", () => {
    for (const h of HARNESS_REGISTRY) expect(HARNESS_BY_ID.get(h.id)).toBe(h);
  });

  it("VALID_HARNESS_IDS derives exactly from the registry, and config-types re-exports the same list", () => {
    expect([...VALID_HARNESS_IDS] as string[]).toEqual(HARNESS_REGISTRY.map((h) => h.id));
    expect([...CONFIG_VALID_HARNESS_IDS]).toEqual([...VALID_HARNESS_IDS]);
  });

  it("ids are unique and every harness folder is registered", () => {
    const ids = HARNESS_REGISTRY.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    const folders = fs
      .readdirSync(HARNESS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(folders).toEqual([...ids].sort());
  });

  it("rejects aliases and unknown ids", () => {
    expect(getHarness("claude")).toBeDefined();
    expect(getHarness("claude-code")).toBeUndefined();
    expect(getHarness("opencode-headless")).toBeUndefined();
    expect(getHarness("nope")).toBeUndefined();
  });

  it("the generated docs table in configuration.md matches the registry", () => {
    expect(checkHarnessDocsDrift().upToDate).toBe(true);
  });
});

describe.each(HARNESS_REGISTRY.map((h) => [h.id, h] as const))("harness contract: %s", (id, h) => {
  test("is a self-contained folder named after its id", () => {
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(fs.existsSync(path.join(HARNESS_DIR, id, "index.ts"))).toBe(true);
    expect(h.displayName.length).toBeGreaterThan(0);
  });

  test("dispatch: it builds a command, and has a built-in profile", () => {
    expect(typeof h.build).toBe("function");
    expect(h.profile.bin).toBeTruthy();
    expect(getBuiltinAgentProfile(id)?.bin).toBe(h.profile.bin);
    expect(getBuiltinAgentProfile(id)?.envPassthrough).toContain("PATH");
    expect(getBuiltinAgentProfile(`${id}-headless`)).toBeUndefined();
  });

  test("the config schema accepts it as a harness platform", () => {
    expect(VALID_HARNESS_IDS as readonly string[]).toContain(id);
    expect(validateConfigShape({ configVersion: "0.9.0", harnesses: { e: { platform: id } } }).ok).toBe(true);
  });

  test("a session-log provider, when there is one, names this harness; a detection dir needs one", () => {
    if (h.sessionLogProvider) expect(h.sessionLogProvider().name).toBe(id);
    if (h.setupDetectionDir) expect(h.sessionLogProvider).toBeDefined();
  });
});

describe("derived lists", () => {
  it("SESSION_LOG_HARNESSES = harnesses with native session logs (claude, codex, opencode)", () => {
    expect(SESSION_LOG_HARNESSES.map((h) => h.id)).toEqual(["opencode", "claude", "codex"]);
  });

  it("setup stash-source candidates = session-log harnesses with a detection dir (claude, opencode)", () => {
    expect(SESSION_LOG_HARNESSES.filter((h) => h.setupDetectionDir).map((h) => h.id)).toEqual(["opencode", "claude"]);
  });

  it("HARNESS_NATIVE_AGENT_IDS = harnesses that run a named agent of their own", () => {
    expect([...HARNESS_NATIVE_AGENT_IDS].sort()).toEqual(["claude", "opencode"]);
  });
});

describe("workflow agent identity markers", () => {
  it("session-id vars are on identityEnv, presence-only flags on presenceEnv", () => {
    // Claude Code exports CLAUDE_CODE_SESSION_ID to the commands it runs.
    expect([...(requireHarness("claude").identityEnv ?? [])]).toEqual(["CLAUDE_CODE_SESSION_ID"]);
    // OpenCode 2's shell tool exports OPENCODE_SESSION_ID for the commands it runs.
    expect([...(requireHarness("opencode").identityEnv ?? [])]).toEqual(["OPENCODE_SESSION_ID"]);
    // CODEX_SANDBOX=seatbelt and GEMINI_CLI=1 carry a sandbox mode and a bare flag, never a session id.
    expect(requireHarness("codex").identityEnv).toBeUndefined();
    expect([...(requireHarness("codex").presenceEnv ?? [])]).toEqual(["CODEX_SANDBOX"]);
    expect(requireHarness("gemini").identityEnv).toBeUndefined();
    expect([...(requireHarness("gemini").presenceEnv ?? [])]).toEqual(["GEMINI_CLI"]);
    // No other harness sets a session variable on the processes it spawns.
    for (const id of ["copilot", "pi", "aider", "amazonq", "openhands"]) {
      expect(requireHarness(id).identityEnv).toBeUndefined();
      expect(requireHarness(id).presenceEnv).toBeUndefined();
    }
  });

  it("markers are unique across harnesses (no ambiguous attribution)", () => {
    const all = HARNESS_REGISTRY.flatMap((h) => [...(h.identityEnv ?? []), ...(h.presenceEnv ?? [])]);
    expect(new Set(all).size).toBe(all.length);
  });
});

// #915: harness ids are persisted keys (`extract_sessions_seen.harness`,
// `workflow_runs.agent_harness`). This literal is deliberately NOT derived from
// the registry: removing or renaming an id must fail here until a state
// migration ships for the old key (see 027-extract-sessions-seen-harness-rename).
// Adding a harness needs no edit here. (akm's own runtime was never a harness id.)
const PERSISTED_HARNESS_IDS = [
  "opencode",
  "claude",
  "codex",
  "copilot",
  "pi",
  "gemini",
  "aider",
  "amazonq",
  "openhands",
];

describe("harness ids are persisted keys (#915)", () => {
  for (const id of PERSISTED_HARNESS_IDS) {
    it(`"${id}" is still registered; removing or renaming it needs a state migration`, () => {
      expect(getHarness(id)).toBeDefined();
    });
  }
});
