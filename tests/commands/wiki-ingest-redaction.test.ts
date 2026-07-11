// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import { __setTestServer, closeServer } from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { createWiki } from "../../src/wiki/wiki";
import { runCliCapture } from "../_helpers/cli";
import { makeStashDir, withEnv, writeSandboxConfig } from "../_helpers/sandbox";

afterEach(async () => {
  __setTestServer(null);
  await closeServer();
});

test("wiki ingest redacts an echoed engine credential before rendering", async () => {
  const sentinel = "WIKI-ECHO-SENTINEL";
  const stash = makeStashDir();
  try {
    createWiki(stash.dir, "redaction-test");
    writeSandboxConfig({
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "fallback" },
        fallback: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test-model",
          apiKey: "$WIKI_TEST_KEY",
        },
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    });
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "wiki-session" } }),
          prompt: async () => ({ data: { parts: [{ type: "text", text: `echo ${sentinel}` }] } }),
          delete: async () => ({}),
        },
      },
      server: { close() {} },
    });

    const result = await withEnv({ AKM_STASH_DIR: stash.dir, WIKI_TEST_KEY: sentinel }, () =>
      runCliCapture(["wiki", "ingest", "redaction-test", "--engine", "sdk"]),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(sentinel);
    expect(result.stdout).toContain("[REDACTED]");
  } finally {
    stash.cleanup();
  }
});
