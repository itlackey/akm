// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { slugForPath } from "../../src/core/bundle-id";
import { openStateDatabase } from "../../src/core/state-db";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    harnesses: { audit: { platform: "aider", bin: "/bin/true" } },
  });
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "deploy.md"),
    "---\ndescription: Deployment guide\n---\n\nDeploy safely.\n",
  );
  fs.writeFileSync(
    path.join(storage.stashDir, "memories", "existing.md"),
    "---\ndescription: Existing rollout note\n---\n\nRollout context.\n",
  );
  fs.writeFileSync(
    path.join(storage.stashDir, "agents", "reviewer.md"),
    "---\ndescription: Review agent\n---\n\nReview deployment plans.\n",
  );
});

afterEach(() => storage.cleanup());

test("audit provenance survives curate, remember, and agent nested reads", async () => {
  const indexed = await runCliCapture(["index", "--full"]);
  expect(indexed.code).toBe(0);

  const state = openStateDatabase();
  state.prepare("DELETE FROM usage_events").run();
  state.close();

  await withEnv({ AKM_EVENT_SOURCE: "audit" }, async () => {
    const curate = await runCliCapture(["curate", "deploy", "--format=json"]);
    expect(curate.code).toBe(0);
    const remember = await runCliCapture(["remember", "Rollout context for tomorrow", "--show-similar"]);
    expect(remember.code).toBe(0);
    const agent = await runCliCapture([
      "agent",
      "agents/reviewer",
      "--engine",
      "audit",
      "--prompt",
      "Review this plan",
    ]);
    expect(agent.code).toBe(0);
  });

  const verify = openStateDatabase();
  try {
    const rows = verify.prepare("SELECT event_type, entry_ref, source FROM usage_events ORDER BY id").all() as Array<{
      event_type: string;
      entry_ref: string | null;
      source: string;
    }>;
    expect(rows.length).toBeGreaterThan(3);
    expect(new Set(rows.map((row) => row.event_type))).toEqual(new Set(["show", "curate", "search"]));
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["audit"]));
    expect(rows.filter((row) => row.event_type === "show")).toEqual([
      {
        event_type: "show",
        entry_ref: `${slugForPath(storage.stashDir)}//agents/reviewer`,
        source: "audit",
      },
    ]);
  } finally {
    verify.close();
  }
});
