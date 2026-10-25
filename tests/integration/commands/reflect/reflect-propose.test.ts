/**
 * Mock-CLI tests for `akm reflect` and `akm propose` (#226).
 *
 * These exercise the proposal-producer pipeline end-to-end without spawning
 * a real agent CLI. A fake harness binary stands in for it (see
 * `tests/_helpers/engine-stubs.ts`), so failure-reason branches are
 * deterministic.
 *
 * Coverage:
 *   • Happy path → proposal materialised in the queue.
 *   • Each {@link AgentFailureReason} → no proposal, ok:false envelope.
 *   • `reflect_invoked` / `propose_invoked` events emitted at command entry
 *     even when the agent fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmReflect, REFLECT_JSON_SCHEMA } from "../../../../src/commands/improve/reflect";
import { akmPropose } from "../../../../src/commands/proposal/propose";
import { listProposals } from "../../../../src/commands/proposal/repository";
import { appendEvent, readEvents } from "../../../../src/core/events";
import { akmIndex } from "../../../../src/indexer/indexer";
import { durableItemRef } from "../../../_helpers/durable-ref";
import { type FakeHarnessOptions, harnessCalls, promptOf, writeFakeHarness } from "../../../_helpers/engine-stubs";
import { quietQualityGateConfig, reflectReply } from "../../../_helpers/factories";
import {
  type Cleanup,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "../../../_helpers/sandbox";

// ── Setup ──────────────────────────────────────────────────────────────────

// Generic fixture dirs (not AKM env paths) — raw mkdtempSync is fine here.
const fixtureDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  // sandboxStashDir already creates lessons/skills/memories/knowledge;
  // this helper is used for inline stash dirs (not the env-var-backed one)
  const stash = makeTempDir("akm-reflect-stash-");
  for (const dir of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

let agents = 0;

/** A fake agent binary that answers `replies` in turn; its path, for `quietQualityGateConfig(bin)`. */
function agent(replies: readonly string[], options?: FakeHarnessOptions): string {
  agents += 1;
  return writeFakeHarness(makeTempDir("akm-reflect-propose-bin-"), `fake-agent-${agents}`, replies, options);
}

/** What an engine of any kind replies to a reflect run on `lessons/rg-over-grep`. */
const LESSON_PATCH = {
  description: "Use ripgrep before grep",
  when_to_use: "Searching large repos for patterns",
};
const VALID_LESSON_PAYLOAD = reflectReply(LESSON_PATCH);
/** The asset that reply patches. */
const LESSON_SOURCE = "---\ndescription: Search guidance\nwhen_to_use: Searching repositories\n---\n\nUse grep.\n";

const VALID_SKILL_PAYLOAD = JSON.stringify({
  ref: "skills/hello",
  content: "---\ndescription: Say hi\nwhen_to_use: When greeting\n---\n\nSay hi politely.\n",
});

let cleanup: Cleanup = () => {};
let xdgDataDir = "";

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  xdgDataDir = dataResult.dir;
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  cleanup = cfgResult.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  for (const dir of fixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── reflect ─────────────────────────────────────────────────────────────────

describe("akm reflect", () => {
  test("loads a duplicate ref only from the selected source root", async () => {
    const selected = makeStashDir();
    const other = makeStashDir();
    fs.writeFileSync(
      path.join(selected, "lessons", "rg-over-grep.md"),
      "---\ndescription: Selected lesson\nwhen_to_use: Selected source\n---\n\nSELECTED SOURCE BODY\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(other, "lessons", "rg-over-grep.md"),
      "---\ndescription: Other lesson\nwhen_to_use: Other source\n---\n\nOTHER SOURCE BODY\n",
      "utf8",
    );
    await akmIndex({ stashDir: other, full: true });
    const bin = agent([VALID_LESSON_PAYLOAD]);

    const result = await akmReflect({
      ref: "lessons/rg-over-grep",
      stashDir: selected,
      config: quietQualityGateConfig(bin),
    });

    expect(result.ok).toBe(true);
    const prompt = promptOf(harnessCalls(bin)[0]);
    expect(prompt).toContain("SELECTED SOURCE BODY");
    expect(prompt).not.toContain("OTHER SOURCE BODY");
  });

  test("reads feedback using item_ref when planning supplied one", async () => {
    const stash = makeStashDir();
    const itemRef = durableItemRef(stash, "lesson", "rg-over-grep");
    appendEvent({
      eventType: "feedback",
      ref: itemRef,
      metadata: { signal: "negative", note: "qualified feedback" },
    });
    const bin = agent(["not json"]);

    const result = await akmReflect({
      ref: "lessons/rg-over-grep",
      itemRef,
      assetContent: LESSON_SOURCE,
      stashDir: stash,
      config: quietQualityGateConfig(bin),
    });

    expect(result.ok).toBe(false);
    const prompt = promptOf(harnessCalls(bin)[0]);
    expect(prompt).toContain("[negative] qualified feedback");
  });

  test("rejects an echoed engine environment credential instead of persisting redacted proposal text", async () => {
    const sentinel = "REFLECT-ECHO-SENTINEL";
    const stash = makeStashDir();
    const echoed = reflectReply({ description: `Use ripgrep before grep ${sentinel}` });
    const result = await withEnv({ GEMINI_API_KEY: sentinel }, () =>
      akmReflect({
        ref: "lessons/rg-over-grep",
        stashDir: stash,
        config: quietQualityGateConfig(agent([echoed])),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsafe content rejection");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toMatch(/configured credential|\[REDACTED\]/);
    expect(result.error).not.toContain(sentinel);
    expect(listProposals(stash)).toEqual([]);
  });
  test("happy path: produces a queued proposal with source=reflect", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/rg-over-grep",
      stashDir: stash,
      config: quietQualityGateConfig(agent([VALID_LESSON_PAYLOAD])),
      assetContent: LESSON_SOURCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.source).toBe("reflect");
    expect(result.proposal.ref).toBe(durableItemRef(stash, "lesson", "rg-over-grep"));
    expect(result.proposal.payload.content).toContain("description: Use ripgrep before grep");
    expect(result.proposal.payload.content).toEndWith("\n\nUse grep.\n");

    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.id).toBe(result.proposal.id);

    const events = readEvents({ type: "reflect_invoked" });
    expect(events.events.length).toBe(1);
    expect(events.events[0]?.ref).toBe("lessons/rg-over-grep");
  });

  test("attribution: eligibilitySource stamps reflect_invoked event + proposal record", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/rg-over-grep",
      stashDir: stash,
      config: quietQualityGateConfig(agent([VALID_LESSON_PAYLOAD])),
      assetContent: LESSON_SOURCE,
      eligibilitySource: "proactive",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // (a) reflect_invoked event carries the lane.
    const events = readEvents({ type: "reflect_invoked" });
    expect(events.events.length).toBe(1);
    expect((events.events[0]?.metadata as { eligibilitySource?: string }).eligibilitySource).toBe("proactive");

    // (b) the persisted proposal record carries the lane (survives across runs).
    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.eligibilitySource).toBe("proactive");
  });

  test("attribution: omitted eligibilitySource leaves reflect_invoked + proposal unstamped", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/rg-over-grep",
      stashDir: stash,
      config: quietQualityGateConfig(agent([VALID_LESSON_PAYLOAD])),
      assetContent: LESSON_SOURCE,
    });
    expect(result.ok).toBe(true);
    // Durable contract: the persisted proposal record carries no lane when none
    // was supplied. (Primary assertion — listProposals is the cross-run source
    // of truth for attribution.)
    expect(listProposals(stash)[0]?.eligibilitySource).toBeUndefined();
    // And the reflect_invoked event likewise carries no lane (null-safe: absence
    // of the field is the contract whether or not the event row is present).
    const events = readEvents({ type: "reflect_invoked" });
    expect(
      (events.events[0]?.metadata as { eligibilitySource?: string } | undefined)?.eligibilitySource,
    ).toBeUndefined();
  });

  test("emits reflect_invoked even when the agent fails", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/bad",
      stashDir: stash,
      config: quietQualityGateConfig(agent([""], { stderr: "boom", exitCode: 7 })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(7);
    expect(listProposals(stash).length).toBe(0);

    const events = readEvents({ type: "reflect_invoked" });
    expect(events.events.length).toBe(1);
  });

  test("spawn_failed → no proposal, structured envelope", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/any",
      stashDir: stash,
      config: quietQualityGateConfig(path.join(makeTempDir("akm-reflect-propose-bin-"), "no-such-agent")),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("spawn_failed");
    expect(listProposals(stash).length).toBe(0);
  });

  test("parse_error → agent stdout is not a valid proposal payload", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/any",
      stashDir: stash,
      config: quietQualityGateConfig(agent(["not a json object"])),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(listProposals(stash).length).toBe(0);
  });

  test("raw markdown output is rejected when it ignores the proposal contract", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "lessons/any",
      stashDir: stash,
      config: quietQualityGateConfig(
        agent([
          "---\ndescription: Use ripgrep for recursive repository searches\nwhen_to_use: Searching a repository recursively\n---\n\n# Title\n\nUse rg for recursive search.\n",
        ]),
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(listProposals(stash).length).toBe(0);
  });

  test("timeout → no proposal, reason=timeout", async () => {
    const stash = makeStashDir();

    const result = await akmReflect({
      ref: "lessons/any",
      stashDir: stash,
      config: quietQualityGateConfig(agent([""], { hang: true })),
      timeoutMs: 400,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("timeout");
    expect(listProposals(stash).length).toBe(0);
  });

  test("ref omitted: still queues a proposal when the agent supplies one", async () => {
    const stash = makeStashDir();
    appendEvent({
      eventType: "feedback",
      ref: "lessons/rg-over-grep",
      metadata: { signal: "negative", note: "too vague" },
    });
    appendEvent({
      eventType: "feedback",
      ref: "skills/hello",
      metadata: { signal: "positive", note: "nice greeting" },
    });
    const unscoped = reflectReply(LESSON_PATCH, { ref: "lessons/rg-over-grep" });
    const bin = agent([unscoped]);
    const result = await akmReflect({
      stashDir: stash,
      task: "Focus on the highest-value recent signal",
      config: quietQualityGateConfig(bin),
      // The asset the reply names, read once it has named it.
      assetContent: LESSON_SOURCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(listProposals(stash).length).toBe(1);
    const prompt = promptOf(harnessCalls(bin)[0]);
    expect(prompt).toContain("No target ref was supplied.");
    expect(prompt).toContain("lessons/rg-over-grep [negative] too vague");
    expect(prompt).toContain("skills/hello [positive] nice greeting");
    expect(prompt).toContain("Task / focus: Focus on the highest-value recent signal");

    const events = readEvents({ type: "reflect_invoked" });
    expect(events.events.length).toBe(1);
    // No ref on the event — we did not pass one in.
    expect(events.events[0]?.ref).toBeUndefined();
    expect(events.events[0]?.metadata?.task).toBe("Focus on the highest-value recent signal");
  });

  test("asks an agent for the same JSON reply as an LLM: its schema is the output schema", async () => {
    const stash = makeStashDir();
    const bin = agent([VALID_LESSON_PAYLOAD]);
    const result = await akmReflect({
      ref: "lessons/rg-over-grep",
      stashDir: stash,
      task: "Tighten the guidance",
      config: quietQualityGateConfig(bin),
      assetContent: LESSON_SOURCE,
    });

    expect(result.ok).toBe(true);
    // Under the model-work tool policy an agent edits only its own scratch directory, so the
    // proposal comes back on stdout, as the JSON object an LLM engine gets natively.
    const prompt = promptOf(harnessCalls(bin)[0]);
    expect(prompt).toContain("Task / focus: Tighten the guidance");
    expect(prompt).toContain("Respond only through the provider's native JSON schema.");
    expect(
      prompt.endsWith(
        `\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(REFLECT_JSON_SCHEMA)}`,
      ),
    ).toBe(true);
  });
});

// ── propose ────────────────────────────────────────────────────────────────

describe("akm propose", () => {
  test("nothing configured leaves proposal and event state untouched", async () => {
    const stash = makeStashDir();

    await expect(
      akmPropose({
        type: "skill",
        name: "nothing-configured",
        task: "Author a skill without mutating state before dispatch",
        stashDir: stash,
        agentConfig: { configVersion: "0.9.0", semanticSearchMode: "off" },
      }),
    ).rejects.toMatchObject({ name: "ConfigError", code: "AGENT_NOT_CONFIGURED" });

    expect(fs.readdirSync(xdgDataDir, { recursive: true })).toEqual([]);
    expect(fs.existsSync(path.join(stash, "proposals"))).toBe(false);
  });

  test("rejects an echoed engine environment credential instead of persisting redacted proposal text", async () => {
    const sentinel = "PROPOSE-ECHO-SENTINEL";
    const stash = makeStashDir();
    const echoed = VALID_SKILL_PAYLOAD.replace("Say hi politely.", `Say hi politely. ${sentinel}`);
    const result = await withEnv({ GEMINI_API_KEY: sentinel }, () =>
      akmPropose({
        type: "skill",
        name: "hello",
        task: "Say hi",
        stashDir: stash,
        agentConfig: quietQualityGateConfig(agent([echoed])),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsafe content rejection");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toMatch(/configured credential|\[REDACTED\]/);
    expect(result.error).not.toContain(sentinel);
    expect(listProposals(stash)).toEqual([]);
  });
  test("happy path: produces a queued proposal with source=propose", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi politely",
      stashDir: stash,
      agentConfig: quietQualityGateConfig(agent([VALID_SKILL_PAYLOAD])),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.notices).toBeUndefined();
    expect(result.proposal.source).toBe("propose");
    expect(result.proposal.ref).toBe(durableItemRef(stash, "skill", "hello"));

    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);

    const events = readEvents({ type: "propose_invoked" });
    expect(events.events.length).toBe(1);
    // WI-8.5b: propose_invoked now carries the same fully-qualified item_ref the
    // durable proposal is minted under.
    expect(events.events[0]?.ref).toBe(durableItemRef(stash, "skill", "hello"));
  });

  test("proposals use the resolved bundle name rather than the source root", async () => {
    const stash = makeStashDir();
    const payload = JSON.stringify({
      ref: "skills/bundle-named",
      content: "---\ndescription: A skill proposed into a named bundle\n---\n\nBundle body.\n",
    });
    const config = {
      ...quietQualityGateConfig(agent([payload])),
      bundles: { team: { path: stash, writable: true } },
      defaultBundle: "team",
    } as ReturnType<typeof quietQualityGateConfig>;

    const result = await akmPropose({
      type: "skill",
      name: "bundle-named",
      task: "Propose into the named bundle",
      stashDir: stash,
      agentConfig: config,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.ref).toBe("team//skills/bundle-named");
  });

  test("rejects unknown type with UsageError", async () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      await akmPropose({
        type: "nonsense-type",
        name: "anything",
        task: "do a thing",
        stashDir: stash,
        agentConfig: quietQualityGateConfig(agent([VALID_SKILL_PAYLOAD])),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("unknown asset type");
  });

  test("rejects missing task with UsageError", async () => {
    const stash = makeStashDir();
    let thrown: unknown;
    try {
      await akmPropose({
        type: "skill",
        name: "x",
        task: "",
        stashDir: stash,
        agentConfig: quietQualityGateConfig(agent([VALID_SKILL_PAYLOAD])),
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain("--task is required");
  });

  test("non_zero_exit: structured failure, no proposal, propose_invoked still emitted", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentConfig: quietQualityGateConfig(agent([""], { stderr: "agent failed", exitCode: 3 })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(3);
    expect(listProposals(stash).length).toBe(0);

    const events = readEvents({ type: "propose_invoked" });
    expect(events.events.length).toBe(1);
  });

  test("parse_error: agent returned malformed payload", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentConfig: quietQualityGateConfig(agent(['{"ref": "skills/hello"}'])),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(listProposals(stash).length).toBe(0);
  });

  test("parse_error: rejects agent refs whose type does not match the requested type", async () => {
    const stash = makeStashDir();
    const mismatchedPayload = JSON.stringify({
      ref: "lessons/hello",
      content: "---\ndescription: Say hi\nwhen_to_use: When greeting\n---\n\nSay hi politely.\n",
    });
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentConfig: quietQualityGateConfig(agent([mismatchedPayload])),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("parse_error");
    expect(result.error).toContain("expected skill");
    expect(listProposals(stash).length).toBe(0);
  });

  test("spawn_failed: structured failure, no proposal", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi",
      stashDir: stash,
      agentConfig: quietQualityGateConfig(path.join(makeTempDir("akm-reflect-propose-bin-"), "no-such-agent")),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("spawn_failed");
    expect(result.notices).toBeUndefined();
    expect(listProposals(stash).length).toBe(0);
  });

  // ── #284 GAP-HIGH 3: registered custom type ──────────────────────────────
  test("akmPropose accepts a custom type registered via registerAssetSpec", async () => {
    const { registerAssetSpec, deregisterAssetSpec } = await import("../../../../src/core/asset/asset-placement");
    registerAssetSpec("widget", {
      stashDir: "widgets",
      isRelevantFile: (f: string) => f.endsWith(".md"),
      toCanonicalName: (_root: string, fp: string) => fp,
      toAssetPath: (root: string, name: string) => `${root}/${name}.md`,
    } as never);
    try {
      const stash = makeStashDir();
      fs.mkdirSync(path.join(stash, "widgets"), { recursive: true });
      const widgetPayload = JSON.stringify({
        ref: "widgets/gear",
        content: "---\ndescription: a gear widget\nwhen_to_use: when grinding\n---\n\nbody.\n",
      });
      const result = await akmPropose({
        type: "widget",
        name: "gear",
        task: "Build a gear widget",
        stashDir: stash,
        agentConfig: quietQualityGateConfig(agent([widgetPayload])),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.proposal.ref).toBe(durableItemRef(stash, "widget", "gear"));
    } finally {
      deregisterAssetSpec("widget");
    }
  });

  test("never writes to live stash content (only proposal queue)", async () => {
    const stash = makeStashDir();
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task: "Say hi politely",
      stashDir: stash,
      agentConfig: quietQualityGateConfig(agent([VALID_SKILL_PAYLOAD])),
    });
    expect(result.ok).toBe(true);
    // The skill file should NOT be materialised — only the proposal entry.
    const skillsDir = path.join(stash, "skills");
    const entries = fs.readdirSync(skillsDir);
    expect(entries.filter((e) => e !== ".akm")).toEqual([]);
    // Proposal queue has exactly one entry.
    const queued = listProposals(stash, { status: "pending" });
    expect(queued.length).toBe(1);
    expect(queued[0]?.ref).toBe(durableItemRef(stash, "skill", "hello"));
  });
});
