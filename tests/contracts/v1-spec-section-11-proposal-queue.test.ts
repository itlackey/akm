import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmDistill } from "../../src/commands/improve/distill";
import { akmReflect } from "../../src/commands/improve/reflect";
import { akmPropose } from "../../src/commands/proposal/propose";
import type { AkmConfig } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";
import { quietQualityGateConfig } from "../_helpers/factories";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §11 — Proposal queue (Planned for v1).

const REQUIRED_PROPOSAL_FIELDS = ["id", "ref", "status", "source", "sourceRun", "createdAt", "updatedAt"];

const REQUIRED_PROPOSAL_COMMANDS = [
  "proposal list",
  "proposal show",
  "proposal diff",
  "proposal accept",
  "proposal reject",
];

const REQUIRED_EVENTS = ["improve_invoked", "promoted", "rejected"];

describe("v1 spec §11 — proposal queue", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 11. Proposal queue");

  test("§11 exists and is marked shipped", () => {
    expect(section).not.toBe("");
    expect(section).toContain("(shipped)");
  });

  test("§11.1 names the state.db `proposals` table as the durable store", () => {
    // Storage is the `proposals` table in state.db (#578) — one row per
    // proposal, keyed by UUID, partitioned by stash_dir.
    expect(section).toContain("`proposals` table");
    expect(section).toContain("state.db");
    expect(section).toContain("stash_dir");
  });

  test("§11.1 documents the legacy filesystem import for pre-0.9.0 stashes", () => {
    // Pre-0.9.0 stashes stored proposals as per-uuid JSON directories; the
    // first proposal operation imports them into the table (idempotent).
    expect(section).toContain(".akm/proposals/<id>/");
    expect(section).toContain("proposal_fs_imports");
    expect(section).toMatch(/never duplicate|idempotent/i);
  });

  test("§11.1 declares each required proposal field", () => {
    for (const field of REQUIRED_PROPOSAL_FIELDS) {
      expect(section).toContain(`\`${field}\``);
    }
  });

  test("§11.1 declares pending/accepted/rejected/reverted statuses + archive-by-status", () => {
    expect(section).toContain("`pending`");
    expect(section).toContain("`accepted`");
    expect(section).toContain("`rejected`");
    expect(section).toContain("`reverted`");
    // Archival is a status flip, not a move (see §11.1 prose).
    expect(section).toMatch(/status flip|archival is a status/i);
  });

  test("§11.2 lists every proposal subcommand", () => {
    for (const cmd of REQUIRED_PROPOSAL_COMMANDS) {
      expect(section).toContain(`akm ${cmd}`);
    }
  });

  test("§11.2 says `accept` validates BEFORE promoting", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toMatch(/validation .*\*\*before\*\* promoting/i);
  });

  test("§11.2 says `accept` promotes via writeAssetToSource()", () => {
    // The locked rule is "all asset writes funnel through writeAssetToSource".
    // The proposal queue is the only legal path that bypasses it for queue
    // state — promotion must hand back to the single dispatch point.
    expect(section).toContain("writeAssetToSource()");
  });

  test("§11.1 says multiple proposals per `ref` coexist", () => {
    // The id is per-proposal; the ref isn't unique. The queue must hold N
    // proposals for the same target ref without filesystem collisions.
    // Directory-per-id is the mechanism the spec calls out for this.
    expect(section).toMatch(/multiple proposals.*for the same `ref`|coexist for the same `ref`/i);
  });

  test("§11.2 names a `--reason` flag on `reject`", () => {
    expect(section).toMatch(/akm proposal reject.*--reason/);
  });

  test("§11.3 declares every locked event name", () => {
    for (const event of REQUIRED_EVENTS) {
      expect(section).toContain(`\`${event}\``);
    }
  });

  test("§11.3 says other plugins cannot reuse these event names", () => {
    expect(section).toMatch(/cannot reuse these names/i);
  });

  test("§11 stops before §12 (helper boundary check)", () => {
    // Defensive: extractSection() returns to EOF if no sibling stop
    // heading exists. Pin the section terminus so a missing §12 heading
    // (or a renamed one) trips this test instead of silently spilling
    // §12+§13+§14 content into the §11 assertions above.
    expect(section).not.toContain("## 12.");
    expect(section).not.toContain("## 13.");
    expect(section).not.toContain("## 14.");
  });
});

// ── #284 GAP-MED 4: event metadata shape ─────────────────────────────────────
//
// Locks the metadata payload of the producer events so observers (audit,
// dashboards) can rely on consistent keys.

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
  const stash = makeTempDir("akm-events-meta-stash-");
  for (const sub of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
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

function fakeSpawn(stdout: string, exitCode: number): SpawnFn {
  return () => {
    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(""),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
}

const VALID_LESSON_PAYLOAD = JSON.stringify({
  ref: "lesson:rg",
  content: "---\ndescription: Use rg\nwhen_to_use: large repos\n---\n\nUse rg.\n",
});

const VALID_SKILL_PAYLOAD = JSON.stringify({
  ref: "skill:hello",
  content: "---\ndescription: hi\nwhen_to_use: greeting\n---\n\nHi.\n",
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-events-meta-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-events-meta-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-events-meta-data-");
  process.env.XDG_STATE_HOME = makeTempDir("akm-events-meta-state-");
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

describe("§11 event metadata shape (runtime)", () => {
  test("reflect_invoked carries `task` + optional `engine` in metadata", async () => {
    const stash = makeStashDir();
    await akmReflect({
      ref: "lesson:rg",
      task: "focus on perf",
      engine: "fake-agent",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn(VALID_LESSON_PAYLOAD, 0) },
    });
    const { events } = readEvents({ type: "reflect_invoked" });
    expect(events.length).toBe(1);
    const md = (events[0].metadata ?? {}) as Record<string, unknown>;
    expect(md.task).toBe("focus on perf");
    expect(md.engine).toBe("fake-agent");
    expect(events[0].ref).toBe("lesson:rg");
  });

  test("propose_invoked carries `type`+`name`+`task` in metadata", async () => {
    const stash = makeStashDir();
    await akmPropose({
      type: "skill",
      name: "hello",
      task: "say hi",
      stashDir: stash,
      agentConfig: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, 0) },
    });
    const { events } = readEvents({ type: "propose_invoked" });
    expect(events.length).toBe(1);
    const md = (events[0].metadata ?? {}) as Record<string, unknown>;
    expect(md.type).toBe("skill");
    expect(md.name).toBe("hello");
    expect(md.task).toBe("say hi");
    expect(events[0].ref).toBe("skill:hello");
  });

  test("distill_invoked metadata includes `outcome` (queued|skipped|validation_failed)", async () => {
    const stash = makeStashDir();
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
      engines: {
        default: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
        },
      },
      improve: {
        strategies: {
          default: {
            // Quality gate OFF: the contract under test is the distill_invoked
            // event metadata shape on the happy path, not the judge. The gate
            // defaults ON and fails CLOSED (07 P0-2) with this non-judge chat stub.
            processes: { distill: { enabled: true, qualityGate: { enabled: false } } },
          },
        },
      },
      defaults: { llmEngine: "default", improveStrategy: "default" },
    };
    await akmDistill({
      ref: "skill:deploy",
      config,
      stashDir: stash,
      // Use a fixture that passes the description / when_to_use quality validators
      // added in the improve-pipeline-fixes branch. The contract under test is the
      // event metadata shape on the happy path, not lint behaviour.
      chat: async () =>
        [
          "---",
          "description: Always validate the deploy plan in staging before running it in production.",
          "when_to_use: When promoting a new release artifact from the staging cluster to production.",
          "---",
          "",
          "Deploy plans must be exercised end-to-end in staging first.",
          "",
        ].join("\n"),
      lookupFn: async () => null,
      readEventsFn: (() => ({ events: [], nextOffset: 0 })) as never,
    });
    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(1);
    const md = (events[0].metadata ?? {}) as Record<string, unknown>;
    expect(["queued", "skipped", "validation_failed"]).toContain(md.outcome as string);
    // `proposalId` only stamped on the queued path
    if (md.outcome === "queued") expect(typeof md.proposalId).toBe("string");
  });
});
