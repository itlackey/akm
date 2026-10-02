// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-engine contract: every transport meets the same contract, so any
 * engine can stand in for any other. Each row runs the real path, from
 * resolveExecution through buildExecution to runExecution, against local stubs
 * only (no network):
 *
 *   - llm: a Bun.serve stub on 127.0.0.1 answers the real chatCompletion.
 *   - every CLI harness: a fake binary per scenario is the engine's `bin`, so
 *     the real argv builder and runAgent run. A harness reports a provider
 *     error by exiting non-zero; claude 2.1.283 and opencode 1.18.25 do so
 *     against a stub that answers 400.
 *   - opencode-sdk: the runner's __setTestServer seam supplies a fake client.
 *
 * The contract:
 *   C1  Success means the transport succeeded: a provider or harness error is
 *       ok:false, never ok with empty output.
 *   C2  Structured output arrives through a native channel or one uniform
 *       prompt fallback, and is validated with one repair.
 *   C3  A tool policy is enforced or refused at build; `tools: []` means none.
 *   C4  Failures and timeouts are reported the same way on every transport.
 *   C5  Credentials akm owns are checked before dispatch.
 *   C6  Every dispatch leaves one usage record.
 * C1 runs today. The other scenarios are todos until their transports meet them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { buildExecution, resolveExecution } from "../../src/integrations/agent/execution";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { HARNESS_ID_TABLE } from "../../src/integrations/harnesses/ids";
import { __setTestServer } from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const PROVIDER_MESSAGE = "provider exploded: model stub-model not found";

/** The LLM stub answers by the first path segment of the engine's endpoint. */
const LLM_REPLIES: Record<string, () => Response> = {
  "http-500": () => Response.json({ error: { message: PROVIDER_MESSAGE } }, { status: 500 }),
  // OpenRouter answers a provider that fails after the headers with HTTP 200
  // and a body that holds only an `error` object and no `choices`.
  "http-200-error-body": () => Response.json({ error: { code: 502, message: PROVIDER_MESSAGE } }),
};

/** The fake binaries, one per scenario, shared by every CLI harness. */
const CLI_SCRIPTS: Record<string, string> = {
  "exit-1": `#!/bin/sh\necho "${PROVIDER_MESSAGE}" >&2\nexit 1\n`,
};

/** What the fake SDK client's prompt call resolves to, per scenario. */
const SDK_REPLIES: Record<string, unknown> = {
  // An HTTP error: without throwOnError the client resolves to `{ error }`.
  "client-error": { error: { name: "UnknownError", data: { message: PROVIDER_MESSAGE } } },
  // A provider rejection: HTTP 200 with the error on the assistant message.
  "info-error": {
    data: { info: { error: { name: "APIError", data: { message: PROVIDER_MESSAGE, isRetryable: false } } }, parts: [] },
  },
};

let llmStub: ReturnType<typeof Bun.serve>;
let bins: SandboxedDir;

beforeAll(() => {
  llmStub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const scenario = new URL(req.url).pathname.split("/")[1] ?? "";
      return LLM_REPLIES[scenario]?.() ?? new Response("unknown scenario", { status: 404 });
    },
  });
  bins = makeSandboxDir("akm-engine-interchange-bin");
  for (const [scenario, script] of Object.entries(CLI_SCRIPTS)) {
    fs.writeFileSync(path.join(bins.dir, scenario), script, { mode: 0o755 });
  }
});

afterAll(() => {
  llmStub.stop(true);
  bins.cleanup();
});

afterEach(() => {
  __setTestServer(null);
});

interface Transport {
  readonly name: string;
  /** The engine config entry that runs `scenario` on this transport. */
  engine(scenario: string): Record<string, unknown>;
  /** Install whatever the scenario needs outside the engine config. */
  arrange?(scenario: string): void;
}

const LLM: Transport = {
  name: "llm",
  engine: (scenario) => ({
    kind: "llm",
    endpoint: `http://127.0.0.1:${llmStub.port}/${scenario}/v1/chat/completions`,
    model: "stub-model",
  }),
};

const CLI_HARNESSES: Transport[] = HARNESS_ID_TABLE.filter((entry) => entry.id !== "opencode-sdk").map((entry) => ({
  name: entry.id,
  engine: (scenario) => ({ kind: "agent", platform: entry.id, bin: path.join(bins.dir, scenario) }),
}));

const OPENCODE_SDK: Transport = {
  name: "opencode-sdk",
  engine: () => ({ kind: "agent", platform: "opencode-sdk" }),
  arrange: (scenario) => {
    const reply = SDK_REPLIES[scenario];
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "contract-session" } }),
          prompt: async () => reply as never,
          delete: async () => ({}),
        },
      },
      server: { close() {} },
    });
  },
};

/** Resolve, build and run one dispatch of `scenario` on `transport`. */
async function dispatch(transport: Transport, scenario: string): Promise<AgentRunResult> {
  transport.arrange?.(scenario);
  const config = { configVersion: "0.9.0", engines: { contract: transport.engine(scenario) } } as unknown as AkmConfig;
  const resolved = resolveExecution({
    content: "Reply with the single word: pong",
    config,
    current: { engine: "contract" },
  });
  return runExecution(buildExecution(resolved.request, resolved.runner));
}

describe("C1: a provider or harness error is ok:false, never ok with empty output", () => {
  const rows: [string, string, Transport][] = [
    [LLM.name, "http-500", LLM],
    [LLM.name, "http-200-error-body", LLM],
    ...CLI_HARNESSES.map((harness): [string, string, Transport] => [harness.name, "exit-1", harness]),
    [OPENCODE_SDK.name, "client-error", OPENCODE_SDK],
    [OPENCODE_SDK.name, "info-error", OPENCODE_SDK],
  ];

  test.each(rows)("%s: %s", async (_name, scenario, transport) => {
    const result = await dispatch(transport, scenario);

    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect([result.error, result.stderr, result.stdout].join("\n")).toContain(PROVIDER_MESSAGE);
  });
});

// Each todo covers every transport above unless it says otherwise.
describe("C2: structured output", () => {
  test.todo("a valid structured reply is parsed and validated against the schema", () => {});
  test.todo("a malformed structured reply is corrected by one repair turn", () => {});
  test.todo("an empty reply is a parse_error, never success", () => {});
});

describe("C3: tool policy", () => {
  test.todo("tools: [] is enforced, visibly in argv or the injected config, or refused at build", () => {});
});

describe("C4: failures and timeouts", () => {
  test.todo("a timeout is reason timeout, and the child is killed", () => {});
});

describe("C5: credentials", () => {
  test.todo("a missing akm-owned credential (llm, opencode-sdk fallback) is a ConfigError before dispatch", () => {});
});

describe("C6: usage", () => {
  test.todo("one usage record per dispatch, attributed to its engine", () => {});
});
