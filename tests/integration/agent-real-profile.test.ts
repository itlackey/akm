/**
 * Opt-in real-profile integration tests for `akm reflect` and `akm propose` (#226).
 *
 * Skipped by default in CI. Enable by exporting `AKM_REAL_AGENT_TESTS=1`
 * (and a credential for the chosen profile, e.g. `OPENCODE_API_KEY` or
 * `ANTHROPIC_API_KEY`). Each test spawns the actual agent CLI through the
 * documented profile and checks that a proposal lands in the queue.
 *
 * The prompts here are intentionally cheap — single short asset, no long
 * context — to keep cost minimal when developers run them locally.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmPropose } from "../../src/commands/propose";
import { akmReflect } from "../../src/commands/reflect";
import { listProposals } from "../../src/core/proposals";
import { getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";

const REAL_AGENT_TESTS = process.env.AKM_REAL_AGENT_TESTS === "1" || process.env.AKM_REAL_AGENT_TESTS === "true";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-real-agent-stash-");
  for (const dir of ["lessons", "skills"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

beforeAll(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-real-agent-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-real-agent-config-");
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!REAL_AGENT_TESTS)("real-profile integration (opt-in via AKM_REAL_AGENT_TESTS)", () => {
  test("opencode profile produces a queued proposal via akm propose", async () => {
    const profile = getBuiltinAgentProfile("opencode");
    expect(profile).toBeDefined();
    if (!profile) return;
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "real-profile-hello",
      task: "Author a one-line skill that says hello.",
      stashDir: stash,
      agentProfile: { ...profile, stdio: "captured" },
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`propose failed: ${result.reason}: ${result.error}`);
    const proposals = listProposals(stash);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });

  test("claude profile produces a queued proposal via akm reflect", async () => {
    const profile = getBuiltinAgentProfile("claude");
    expect(profile).toBeDefined();
    if (!profile) return;
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lesson:real-profile-tip",
      stashDir: stash,
      agentProfile: { ...profile, stdio: "captured" },
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`reflect failed: ${result.reason}: ${result.error}`);
    const proposals = listProposals(stash);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });
});
