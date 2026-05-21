/**
 * Reflect pipeline safety-rail tests.
 *
 * Covers the regressions found in the May 2026 review of 323 reflect proposals:
 *
 *   1. Frontmatter stripped on rewrite (15+ cases).
 *   2. Catastrophic content shrinkage (75 → 3 lines, 200 → 4 lines).
 *   3. Reflect prepending YAML frontmatter to executable `.ts` script assets.
 *   4. Reflect renaming a skill's identity `name` field.
 *   5. Excessive expansion (>2× source).
 *
 * Each defect is now a hard safety rail in `src/commands/reflect.ts`. These
 * tests lock the rails in place so future refactors cannot reintroduce the
 * regression silently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmReflect } from "../src/commands/reflect";
import { listProposals } from "../src/core/proposals";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../src/integrations/agent/spawn";

// ── Setup ─────────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-reflect-fixes-");
  for (const dir of ["lessons", "skills", "memories", "knowledge", "scripts", "wikis"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "fake-agent",
    bin: "fake-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeSpawn(stdout: string, stderr: string, exitCode: number): SpawnFn {
  return () => {
    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(stderr),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-reflect-fixes-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-reflect-fixes-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-reflect-fixes-data-");
  process.env.XDG_STATE_HOME = makeTempDir("akm-reflect-fixes-state-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
  if (savedEnv.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A 500-character body of concrete content the LLM should be preserving.
 * The shrink / expand tests reference this so the size-guard thresholds
 * (50% min, 200% max) can be evaluated meaningfully.
 */
const LONG_SOURCE_BODY = [
  "# Krang split-horizon AdGuard YAML",
  "",
  "## Required config",
  "",
  "1. Set `bind_host` to `0.0.0.0` so both LAN and VPN clients are served.",
  "2. Add upstream `tls://1.1.1.1` for sanitised DNS over TLS.",
  "3. Register split-horizon rules:",
  "   - `/internal.example.com/192.168.10.5`",
  "   - `/public.example.com/cname:host.example.com`",
  "4. Set `cache_size: 2000` and `cache_ttl_min: 60`.",
  "",
  "## Verification",
  "",
  "- Run `dig @192.168.10.5 internal.example.com` from the LAN.",
  "- Run `dig @1.1.1.1 internal.example.com` externally and confirm NXDOMAIN.",
  "- Check `/var/log/AdGuardHome/query.log` shows both legs.",
].join("\n");

// ── 1. Type guard — reflect refuses executable / non-markdown types ───────────

describe("Reflect type guard — refuses non-markdown asset types", () => {
  test("script:* ref is rejected up-front with a clear error", async () => {
    const stash = makeStashDir();
    let spawned = false;
    const spy: SpawnFn = (cmd) => {
      spawned = true;
      return fakeSpawn("", "", 0)(cmd, {});
    };

    const result = await akmReflect({
      ref: "script:deploy.ts",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: spy },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toContain("not supported by reflect");
    expect(result.error).toContain("script");
    // Spawning the agent must NOT happen — the guard fires before the agent invocation.
    expect(spawned).toBe(false);
    expect(listProposals(stash).length).toBe(0);
  });

  test("vault:* ref is rejected (.env files must never get YAML frontmatter)", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "vault:default",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toContain("vault");
  });

  test("task:* ref is rejected (YAML tasks are not markdown-shaped)", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "task:nightly-backup",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn("", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
  });

  test("knowledge:* (markdown-canonical) is allowed by the type guard", async () => {
    const stash = makeStashDir();
    // No source asset on disk — reflect produces a proposal without size-guard checks.
    const payload = JSON.stringify({
      ref: "knowledge:foo",
      content: "---\ndescription: Foo doc\n---\n\nBody of foo.",
    });
    const result = await akmReflect({
      ref: "knowledge:foo",
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    // Allowed by the type guard — should at least pass that stage without
    // returning the "not supported" error.
    if (!result.ok) {
      expect(result.error).not.toContain("not supported by reflect");
    } else {
      expect(result.proposal.ref).toBe("knowledge:foo");
    }
  });
});

// ── 2. Frontmatter preservation ─────────────────────────────────────────────────

describe("Reflect frontmatter preservation — source frontmatter survives rewrite", () => {
  test("LLM body without frontmatter still results in source frontmatter being present", async () => {
    const stash = makeStashDir();
    // Source asset has rich frontmatter the LLM does NOT emit.
    const sourceContent = [
      "---",
      "description: Release policy for production deploys",
      "when_to_use: Whenever you cut a release branch",
      "tags:",
      "  - release",
      "  - policy",
      "---",
      "",
      LONG_SOURCE_BODY,
      "",
    ].join("\n");

    // LLM rewrites the body only — no frontmatter (correct per new prompt).
    const llmBody = LONG_SOURCE_BODY.replace("## Required config", "## Required configuration");
    const payload = JSON.stringify({ ref: "knowledge:policies/release", content: llmBody });

    const result = await akmReflect({
      ref: "knowledge:policies/release",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const finalContent = result.proposal.payload.content;
    // Frontmatter must be present and contain the original keys.
    expect(finalContent.startsWith("---\n")).toBe(true);
    expect(finalContent).toContain("description: Release policy for production deploys");
    expect(finalContent).toContain("when_to_use: Whenever you cut a release branch");
    expect(finalContent).toContain("- release");
    expect(finalContent).toContain("- policy");
    // Body must include the improved heading.
    expect(finalContent).toContain("## Required configuration");
  });

  test("LLM emits its own frontmatter block in body — stripped but kept via merge", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Original desc\ntags:\n  - one\n  - two\n---\n\n${LONG_SOURCE_BODY}\n`;

    // LLM disobeys the prompt and emits frontmatter inside `content`.
    const llmBlob = [
      "---",
      "description: Updated description by LLM",
      "extra_field: added by LLM",
      "---",
      "",
      LONG_SOURCE_BODY,
    ].join("\n");
    const payload = JSON.stringify({ ref: "knowledge:x", content: llmBlob });

    const result = await akmReflect({
      ref: "knowledge:x",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const finalContent = result.proposal.payload.content;
    // Source `tags` survive even though the LLM tried to replace the frontmatter.
    expect(finalContent).toContain("- one");
    expect(finalContent).toContain("- two");
    // LLM's new field is merged in (LLM can ADD keys, not remove them).
    expect(finalContent).toContain("extra_field");
    // The frontmatter block appears exactly once (no double `---`).
    const fmDelimCount = (finalContent.match(/^---$/gm) ?? []).length;
    expect(fmDelimCount).toBe(2);
  });
});

// ── 3. Size guards — shrink and expand ────────────────────────────────────────

describe("Reflect size guard — diff-size safety rails", () => {
  test("body shrunk below 50% of source is rejected with EXCESSIVE_SHRINKAGE", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Long doc\n---\n\n${LONG_SOURCE_BODY}\n`;

    // LLM returns a 3-line body (catastrophic shrinkage seen in the May 2026 review).
    const tinyBody = "Use AdGuard.\nDone.\n";
    const payload = JSON.stringify({ ref: "knowledge:shrink", content: tinyBody });

    const result = await akmReflect({
      ref: "knowledge:shrink",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toContain("EXCESSIVE_SHRINKAGE");
    expect(listProposals(stash).length).toBe(0);
  });

  test("body expanded above 200% of source is rejected with EXCESSIVE_EXPANSION", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Tight doc\n---\n\n${LONG_SOURCE_BODY}\n`;

    // LLM tripled the asset with speculative material.
    const bloatedBody = `${LONG_SOURCE_BODY}\n\n${LONG_SOURCE_BODY}\n\n${LONG_SOURCE_BODY}`;
    const payload = JSON.stringify({ ref: "knowledge:expand", content: bloatedBody });

    const result = await akmReflect({
      ref: "knowledge:expand",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toContain("EXCESSIVE_EXPANSION");
    expect(listProposals(stash).length).toBe(0);
  });

  test("modest size change (~120%) passes the size guard", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Doc\n---\n\n${LONG_SOURCE_BODY}\n`;

    // Small, justified addition.
    const improvedBody = `${LONG_SOURCE_BODY}\n\n## Notes\n\nVerify with the on-call.`;
    const payload = JSON.stringify({ ref: "knowledge:modest", content: improvedBody });

    const result = await akmReflect({
      ref: "knowledge:modest",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
  });

  test("tiny source asset (<200 bytes) skips size guard so seed assets still work", async () => {
    const stash = makeStashDir();

    // 4× expansion would normally trip the guard, but source body is below the
    // REFLECT_SIZE_GUARD_MIN_BYTES floor so the rail is intentionally permissive.
    const payload = JSON.stringify({
      ref: "lesson:tiny",
      content: "Use rg for searching large repositories. rg is faster than grep and respects .gitignore.\n",
    });

    const result = await akmReflect({
      ref: "lesson:tiny",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: "---\ndescription: tiny\n---\nUse rg.\n",
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
  });
});

// ── 4. Protected identity fields — name / ref / id / slug / type ──────────────

describe("Reflect identity guard — protected frontmatter fields cannot be renamed", () => {
  test("LLM renaming `name` is restored to the source value", async () => {
    const stash = makeStashDir();
    const sourceBody = LONG_SOURCE_BODY;
    const sourceContent = [
      "---",
      "name: openpalm-stack-diagnostics",
      "description: Diagnose the OpenPalm stack",
      "when_to_use: When the stack reports degraded health",
      "---",
      "",
      sourceBody,
      "",
    ].join("\n");

    // LLM tries to rename the skill in frontmatter (#26941510).
    const llmBlob = [
      "---",
      "name: diagnostic-checklist",
      "description: Diagnose the OpenPalm stack",
      "when_to_use: When the stack reports degraded health",
      "---",
      "",
      sourceBody,
    ].join("\n");
    const payload = JSON.stringify({ ref: "skill:openpalm-stack-diagnostics", content: llmBlob });

    const result = await akmReflect({
      ref: "skill:openpalm-stack-diagnostics",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const finalContent = result.proposal.payload.content;
    // The `name` must be restored to the source value.
    expect(finalContent).toContain("name: openpalm-stack-diagnostics");
    expect(finalContent).not.toContain("name: diagnostic-checklist");
    // payload frontmatter object should also carry the restored name.
    expect(result.proposal.payload.frontmatter?.name).toBe("openpalm-stack-diagnostics");
  });

  test("LLM emitting a different `id` field is silently overwritten to source", async () => {
    const stash = makeStashDir();
    const sourceContent = ["---", "id: original-id-12345", "description: doc", "---", "", LONG_SOURCE_BODY, ""].join(
      "\n",
    );

    const llmBlob = ["---", "id: fabricated-by-llm", "description: doc", "---", "", LONG_SOURCE_BODY].join("\n");
    const payload = JSON.stringify({ ref: "knowledge:id-protected", content: llmBlob });

    const result = await akmReflect({
      ref: "knowledge:id-protected",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.payload.content).toContain("id: original-id-12345");
    expect(result.proposal.payload.content).not.toContain("fabricated-by-llm");
  });
});

// ── 5. Positive control — reflect on a markdown asset works end-to-end ────────

describe("Reflect positive control — markdown assets still flow through", () => {
  test("reflect on a knowledge asset produces a proposal with body-only LLM output", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Control\n---\n\n${LONG_SOURCE_BODY}\n`;

    const improved = LONG_SOURCE_BODY.replace("## Verification", "## Verification steps");
    const payload = JSON.stringify({ ref: "knowledge:control", content: improved });

    const result = await akmReflect({
      ref: "knowledge:control",
      stashDir: stash,
      agentProfile: makeProfile(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const content = result.proposal.payload.content;
    expect(content).toContain("description: Control");
    expect(content).toContain("## Verification steps");
    expect(listProposals(stash).length).toBe(1);
  });
});
