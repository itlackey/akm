// Integration: extract resolves the project per session from the session's directory (#1461).
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmExtract } from "../../src/commands/improve/extract";
import { listProposals } from "../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import type { SessionData, SessionLogHarness } from "../../src/integrations/session-logs/types";
import { type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

const evidence = "The operator said: connect VPN first.";

async function run(sessions: Array<{ id: string; cwd?: string }>, project?: string) {
  const stash = storage.stashDir;
  const other = makeSandboxDir("extract-projects-other");
  const acme = fs.realpathSync(makeSandboxDir("extract-projects-acme").dir);
  const config = {
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true }, other: { path: other.dir, writable: true } },
    defaultBundle: "stash",
    connections: { test: { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "test" } } },
    improve: {
      strategy: "extract-only",
      strategies: { "extract-only": { processes: { extract: { enabled: true, triage: { enabled: false } } } } },
    },
    projects: {
      acme: { paths: [acme], write: { bundle: "other", user: "u1", metadata: { client: "acme" } } },
      beta: { write: { channel: "beta" } },
    },
  } as AkmConfig;
  const filePath = path.join(stash, "source.jsonl");
  fs.writeFileSync(filePath, evidence);
  const datas = new Map<string, SessionData>();
  for (const { id, cwd } of sessions) {
    const ref = {
      harness: "claude",
      sessionId: id,
      filePath,
      startedAt: Date.now() - 600_000,
      endedAt: Date.now() - 60_000,
      projectHint: "-home-me-elsewhere",
      ...(cwd === "acme" ? { cwd: acme } : cwd ? { cwd } : {}),
    };
    datas.set(id, { ref, events: [{ harness: "claude", role: "user", text: evidence, filePath }], inlineRefs: [] });
  }
  const harness: SessionLogHarness = {
    name: "claude",
    isAvailable: () => true,
    listSessions: () => [...datas.values()].map((d) => d.ref),
    readSession: (ref) => datas.get(ref.sessionId) as SessionData,
  };
  for (const { id } of sessions) {
    await akmExtract({
      type: "claude",
      sessionId: id,
      stashDir: stash,
      config,
      harnesses: [harness],
      ...(project ? { project } : {}),
      generateSessionSummary: async () => ({ summary: "A VPN prerequisite was established.", keyTopics: ["vpn"] }),
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "memory",
              name: `note-${id}`,
              description: "Connect the VPN before deploying.",
              when_to_use: "When deploying from a new shell.",
              body: "The operator requires connecting the VPN before deployment. The deployment then succeeded.",
              confidence: 0.99,
              evidence,
            },
          ],
        }),
    });
  }
  return { stash, other: other.dir, proposals: listProposals(stash, { status: "pending" }) };
}

const fm = (p: { payload: { content: string } }) => parseFrontmatter(p.payload.content).data;
const byRef = <T extends { ref: string }>(list: T[], part: string) => list.find((p) => p.ref.includes(part));

test("each session takes its own directory's project; an unregistered one gets none", async () => {
  const { proposals } = await run([
    { id: "s-acme", cwd: "acme" },
    { id: "s-other", cwd: "/nowhere/else" },
    { id: "s-none" },
  ]);
  const acme = byRef(proposals, "note-s-acme");
  expect(acme?.ref).toContain("memories/acme/");
  expect(fm(acme!)).toMatchObject({ scope_user: "u1", client: "acme", project: "acme" });
  for (const id of ["s-other", "s-none"]) {
    const p = byRef(proposals, `note-${id}`);
    expect(p?.ref).toContain("memories/home-me-elsewhere/");
    const data = fm(p!);
    expect(data.scope_user).toBeUndefined();
    expect(data.client).toBeUndefined();
  }
});

test("--project names the project for every session; write.bundle is never used", async () => {
  const { stash, other, proposals } = await run([{ id: "s1", cwd: "acme" }, { id: "s2" }], "beta");
  for (const id of ["s1", "s2"]) {
    const p = byRef(proposals, `note-${id}`);
    expect(p?.ref).toContain("memories/beta/");
    expect(fm(p!)).toMatchObject({ scope_channel: "beta", project: "beta" });
  }
  expect(fs.existsSync(path.join(stash, "sessions"))).toBe(true);
  expect(fs.existsSync(path.join(other, "sessions"))).toBe(false);
  expect(listProposals(other, { status: "pending" })).toHaveLength(0);
});

test("--project none turns projects off for every session", async () => {
  const { proposals } = await run([{ id: "s1", cwd: "acme" }], "none");
  const p = byRef(proposals, "note-s1");
  expect(p?.ref).toContain("memories/home-me-elsewhere/");
  expect(fm(p!).scope_user).toBeUndefined();
});
