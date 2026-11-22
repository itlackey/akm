// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A workflow unit whose agent is OpenCode 1 and whose turn ended on a refused tool call has failed, not succeeded:
 * OpenCode 1 exits 0 and prints one sentence, and only its event stream (recorded in tests/fixtures/opencode1-run) says
 * the turn did not finish. The unit keeps the sentence, OpenCode's message and the session id.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmIndex } from "../../../src/indexer/indexer";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const REFUSED_STREAM = path.resolve(import.meta.dir, "../../fixtures/opencode1-run/oc1-json.out");

let storage: IsolatedAkmStorage;
let bins: SandboxedDir;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-opencode1-turn-bin");
  const bin = path.join(bins.dir, "opencode");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.18.25; exit 0; fi\ncat >/dev/null\ncat ${JSON.stringify(REFUSED_STREAM)}\n`,
    { mode: 0o755 },
  );
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    harnesses: { opencode: { platform: "opencode", bin } },
  });
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", "read-host.md"),
    ["---", "type: workflow", "steps:", "  - id: read", "---", "", "## read", "", "Read /etc/hostname.", ""].join("\n"),
  );
  await akmIndex({ stashDir: storage.stashDir, full: true });
});

afterEach(() => {
  bins.cleanup();
  storage.cleanup();
});

describe("a workflow agent unit on OpenCode 1", () => {
  test("whose turn ended on a refused tool call is failed, and keeps the sentence, OpenCode's message and the session id", async () => {
    const run = await runCliCapture(["workflow", "run", "workflows/read-host", "--format=json"]);
    expect(run.code).not.toBe(0);
    const runId = (JSON.parse(run.stdout) as { run: { id: string } }).run.id;

    const status = await runCliCapture(["workflow", "status", runId, "--units", "--format=json"]);

    const { units } = JSON.parse(status.stdout) as {
      units: {
        status: string;
        failureReason: string | null;
        sessionId: string | null;
        text?: string;
        diagnostic?: string;
      }[];
    };
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      status: "failed",
      failureReason: "parse_error",
      sessionId: "ses_e015daf81ffeBDYwsN7qEcmDWR",
    });
    expect(JSON.stringify(units[0])).toContain("I will read the file now.");
    expect(JSON.stringify(units[0])).toContain("The user rejected permission to use this specific tool call.");
  });
});
