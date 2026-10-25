// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: opens a real index and state.db.
//
// akm's read tools (`akm_search`, `akm_show`, `akm_curate`) run in akm's process
// for an agent on an embedded OpenCode. Each call records a usage event, and the
// source it records is the run's own: model work is the improve pipeline's
// traffic, never the user's demand, which feeds ranking.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { AKM_READ_TOOLS } from "../../src/integrations/agent/akm-read-tools";
import { buildExecution, currentLayer, resolveExecution } from "../../src/integrations/agent/execution";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
import { installFakeOpencodeHost } from "../_helpers/fake-opencode-host";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  const file = path.join(storage.stashDir, "knowledge", "quartz.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ndescription: quartz deployment\n---\n\nquartz deployment procedure\n");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir } },
    defaultBundle: "stash",
    registries: [],
    harnesses: { opencode: {} },
  });
  await akmIndex({ stashDir: storage.stashDir, full: true });
  fakeOpencodeMajor(2);
  baseline = recorded().length;
});

afterEach(() => storage.cleanup());

/** The events recorded once the stash was indexed, which the tests under it are not about. */
let baseline = 0;

/** The event type and source of each usage event recorded since the stash was indexed. */
function recorded(): Array<[string, string]> {
  const db = openStateDatabase();
  try {
    return (
      db.prepare("SELECT event_type, source FROM usage_events ORDER BY id").all() as Array<{
        event_type: string;
        source: string;
      }>
    )
      .map((row): [string, string] => [row.event_type, row.source])
      .slice(baseline);
  } finally {
    db.close();
  }
}

const tool = (name: string) => {
  const found = AKM_READ_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const INPUTS: Record<string, Record<string, unknown>> = {
  akm_search: { query: "quartz deployment" },
  akm_curate: { query: "quartz deployment" },
  akm_show: { ref: "knowledge/quartz" },
};

describe("a read tool's usage event", () => {
  for (const [name, type] of [
    ["akm_search", "search"],
    ["akm_curate", "curate"],
    ["akm_show", "show"],
  ] as const) {
    test(`${name} records the source of the run it is called in`, async () => {
      await tool(name).run(INPUTS[name] ?? {}, { eventSource: "improve" });
      const events = recorded().filter(([eventType]) => eventType === type);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(([, source]) => source === "improve")).toBe(true);
    });
  }

  /** The sources of the search events recorded (a search records more than one event). */
  const searchSources = () =>
    new Set(
      recorded()
        .filter(([eventType]) => eventType === "search")
        .map(([, source]) => source),
    );

  test("a run nobody stamped is the user's", async () => {
    await tool("akm_search").run(INPUTS.akm_search ?? {});
    expect(searchSources()).toEqual(new Set(["user"]));
  });

  test("a source that is not one akm knows is recorded as unknown, never as the user's", async () => {
    await tool("akm_search").run(INPUTS.akm_search ?? {}, { eventSource: "who-knows" });
    expect(searchSources()).toEqual(new Set(["unknown"]));
  });
});

describe("a run on the embedded OpenCode", () => {
  /** A request to the opencode harness; its scripted agent calls each read tool in its own session. */
  async function agentRun(options: { modelWork?: boolean; eventSource?: string; inSubagent?: boolean }) {
    const host = installFakeOpencodeHost({
      reply: async (call) => {
        let sessionID = call.sessionID;
        if (options.inSubagent) {
          const child = host.spawnChild("opencode", call.sessionID);
          await child.request();
          sessionID = child.sessionID;
        }
        for (const name of Object.keys(INPUTS)) await host.runTool("opencode", name, INPUTS[name], sessionID);
        return "done";
      },
    });
    const resolved = resolveExecution({
      content: "look it up",
      config: JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "config.json"), "utf8")),
      layers: [currentLayer({})],
      modelWork: options.modelWork === true,
    });
    return runExecution(buildExecution(resolved.request, resolved.runner), {
      ...(options.eventSource ? { eventSource: options.eventSource } : {}),
    });
  }

  const sources = () => new Set(recorded().map(([, source]) => source));

  test("model work records its reads as the improve pipeline's, whoever dispatched it", async () => {
    expect((await agentRun({ modelWork: true })).ok).toBe(true);
    expect(recorded().length).toBeGreaterThanOrEqual(3);
    expect(sources()).toEqual(new Set(["improve"]));
  });

  test("a scheduled task's agent records its reads as the task's", async () => {
    await agentRun({ eventSource: "task" });
    expect(sources()).toEqual(new Set(["task"]));
  });

  test("a subagent the run starts records its reads as the run's", async () => {
    await agentRun({ eventSource: "task", inSubagent: true });
    expect(sources()).toEqual(new Set(["task"]));
  });

  test("an agent run by the user records them as the user's", async () => {
    await agentRun({});
    expect(sources()).toEqual(new Set(["user"]));
  });
});
