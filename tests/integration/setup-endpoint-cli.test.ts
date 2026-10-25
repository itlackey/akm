// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm setup --yes --endpoint ...` against a real loopback server: the model
 * list is fetched over HTTP with the key the variable holds, the config and the
 * printed result carry the connection but never the key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { getConfigPath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let server: ReturnType<typeof Bun.serve>;
let requests: { path: string; authorization: string | null }[];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  requests = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      requests.push({ path: new URL(req.url).pathname, authorization: req.headers.get("authorization") });
      return Response.json({ data: [{ id: "chat-small" }, { id: "chat-large" }] });
    },
  });
});

afterEach(() => {
  server.stop(true);
  storage.cleanup();
});

describe("akm setup --yes --endpoint", () => {
  test("lists the models over HTTP with the key from the named variable and prints no key", async () => {
    const secret = "sk-loopback-secret-value";
    const endpoint = `http://127.0.0.1:${server.port}/v1`;

    const { code, stdout, stderr } = await withEnv({ LOOPBACK_KEY: secret }, () =>
      runCliCapture(["setup", "--yes", "--no-init", "--endpoint", endpoint, "--api-key-env", "LOOPBACK_KEY"]),
    );

    expect(code).toBe(0);
    expect(requests.filter((r) => r.path === "/v1/models")).toEqual([
      { path: "/v1/models", authorization: `Bearer ${secret}` },
    ]);
    const result = JSON.parse(stdout) as { runs: { modelCalls: string; agentWork: string } };
    expect(result.runs.modelCalls).toBe('connection "default" (chat-small)');
    const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as {
      connections: Record<string, unknown>;
    };
    expect(config.connections.default).toEqual({
      endpoint,
      apiKey: "$LOOPBACK_KEY",
      models: { fast: "chat-small", balanced: "chat-small", reasoning: "chat-small" },
    });
    for (const text of [stdout, stderr, fs.readFileSync(getConfigPath(), "utf8")]) expect(text).not.toContain(secret);
  });

  test("--no-probe never contacts the endpoint", async () => {
    const endpoint = `http://127.0.0.1:${server.port}/v1`;

    const { code } = await runCliCapture(["setup", "--yes", "--no-init", "--no-probe", "--endpoint", endpoint]);

    expect(code).toBe(0);
    expect(requests).toEqual([]);
    const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { connections: Record<string, unknown> };
    expect(config.connections.default).toEqual({ endpoint });
  });
});
