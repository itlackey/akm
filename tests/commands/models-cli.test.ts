// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm models` and `akm models set`: the connection's aliases beside the
 * models its endpoint lists, and changing one. The endpoint is a stand-in for
 * `GET <base>/models`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { writeCredential } from "../../src/core/config/credentials";
import { getConfigPath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withEnv,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

const LISTED = ["qwen3-8b", "qwen3-32b", "glm-5"];

/** Serve `LISTED` at `base`, recording the key each request carried; anything else is unreachable. */
function endpoint(base: string, opts: { status?: number } = {}) {
  const keys: (string | null)[] = [];
  return {
    keys,
    serve: <T>(run: () => Promise<T>) =>
      withMockedFetch(run, (url, init) => {
        if (url !== `${base}/models`) throw new Error("unreachable");
        keys.push(new Headers(init?.headers).get("authorization"));
        return opts.status
          ? new Response("no", { status: opts.status })
          : Response.json({ data: LISTED.map((id) => ({ id })) });
      }),
  };
}

const configure = (connections: Record<string, unknown>) =>
  writeSandboxConfig({ semanticSearchMode: "off", connections });
const savedConnections = () =>
  (JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { connections: Record<string, unknown> }).connections;

const LOCAL = {
  endpoint: "http://localhost:11434/v1",
  models: { fast: "qwen3-8b", balanced: "qwen3-32b", reasoning: { model: "qwen3-32b", reasoning_effort: "high" } },
};

describe("akm models", () => {
  test("lists the default connection's picks and the models its endpoint lists", async () => {
    configure({ default: LOCAL });
    const server = endpoint("http://localhost:11434/v1");

    const { code, stdout } = await server.serve(() => runCliCapture(["models"]));

    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      ok: true,
      shape: "models",
      connection: "default",
      aliases: { fast: "qwen3-8b", balanced: "qwen3-32b", reasoning: "qwen3-32b" },
      available: LISTED,
    });
  });

  test("--connection targets another connection", async () => {
    configure({ default: LOCAL, cloud: { endpoint: "https://api.example.test/v1", models: { fast: "gpt" } } });
    const server = endpoint("https://api.example.test/v1");

    const { stdout } = await server.serve(() => runCliCapture(["models", "--connection", "cloud"]));

    expect(JSON.parse(stdout)).toMatchObject({ connection: "cloud", aliases: { fast: "gpt" }, available: LISTED });
  });

  test("a lone connection is the default whatever it is called", async () => {
    configure({ lab: LOCAL });
    const { stdout } = await endpoint("http://localhost:11434/v1").serve(() => runCliCapture(["models"]));
    expect(JSON.parse(stdout).connection).toBe("lab");
  });

  test("sends the connection's key: a $VAR, or the one in credentials.json", async () => {
    configure({
      env: { endpoint: "https://env.example.test/v1", apiKey: "$ENV_KEY" },
      stored: { endpoint: "https://stored.example.test/v1" },
    });
    writeCredential({ connection: "stored" }, "stored-key", "https://stored.example.test/v1");
    const viaEnv = endpoint("https://env.example.test/v1");
    const viaStore = endpoint("https://stored.example.test/v1");

    await withEnv({ ENV_KEY: "env-key" }, () => viaEnv.serve(() => runCliCapture(["models", "--connection", "env"])));
    await viaStore.serve(() => runCliCapture(["models", "--connection", "stored"]));

    expect(viaEnv.keys).toEqual(["Bearer env-key"]);
    expect(viaStore.keys).toEqual(["Bearer stored-key"]);
  });

  test("--no-probe lists the picks only and contacts nothing", async () => {
    configure({ default: LOCAL });
    const server = endpoint("http://localhost:11434/v1");

    const { stdout } = await server.serve(() => runCliCapture(["models", "--no-probe"]));

    expect(JSON.parse(stdout).available).toEqual([]);
    expect(server.keys).toEqual([]);
  });

  test("an endpoint that cannot list its models shows the picks alone, with a warning", async () => {
    configure({ default: LOCAL });

    const { code, stdout, stderr } = await endpoint("http://localhost:11434/v1", { status: 401 }).serve(() =>
      runCliCapture(["models"]),
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout).available).toEqual([]);
    expect(stderr).toContain("Could not list models from http://localhost:11434/v1 (HTTP 401)");
  });

  test("--format text shows the picks, then the available models as a list of their own", async () => {
    configure({ default: LOCAL });

    const { stdout } = await endpoint("http://localhost:11434/v1").serve(() =>
      runCliCapture(["models", "--format", "text"]),
    );

    expect(stdout.trimEnd().split("\n")).toEqual([
      "Connection default",
      "ALIAS      MODEL",
      "fast       qwen3-8b",
      "balanced   qwen3-32b",
      "reasoning  qwen3-32b",
      "",
      "AVAILABLE",
      "  qwen3-8b",
      "  qwen3-32b",
      "  glm-5",
    ]);
  });

  test("--format text with no models listed shows the picks alone", async () => {
    configure({ default: LOCAL });

    const { stdout } = await runCliCapture(["models", "--no-probe", "--format", "text"]);

    expect(stdout.trimEnd().split("\n")).toEqual([
      "Connection default",
      "ALIAS      MODEL",
      "fast       qwen3-8b",
      "balanced   qwen3-32b",
      "reasoning  qwen3-32b",
    ]);
  });

  test("with no connection it says so and points at akm setup", async () => {
    writeSandboxConfig({ semanticSearchMode: "off" });

    const { code, stderr } = await runCliCapture(["models"]);

    expect(code).toBe(78);
    const error = JSON.parse(stderr.trim());
    expect(error.code).toBe("LLM_NOT_CONFIGURED");
    expect(error.error).toContain("akm setup");
  });

  test("a connection that is not configured fails as every named target does: exit 78, the ones that are configured, the closest name", async () => {
    configure({ default: LOCAL, lab: { endpoint: "https://lab.example.test/v1" } });

    const { code, stderr } = await runCliCapture(["models", "--connection", "defualt"]);

    expect(code).toBe(78);
    const error = JSON.parse(stderr.trim());
    expect(error.code).toBe("SELECTION_NOT_CONFIGURED");
    expect(error.error).toBe(
      'Connection "defualt" is not configured. Configured connections: default, lab. Did you mean "default"?',
    );
  });

  test("models set names the same error, and changes nothing", async () => {
    configure({ default: LOCAL });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const { code, stderr } = await runCliCapture(["models", "set", "fast", "glm-5", "--connection", "ghost"]);

    expect(code).toBe(78);
    expect(JSON.parse(stderr.trim()).code).toBe("SELECTION_NOT_CONFIGURED");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });
});

describe("akm models set", () => {
  test("changes the model an alias names, leaving the rest of the config as it was", async () => {
    configure({ default: LOCAL, other: { endpoint: "https://o.example.test/v1" } });

    const { code, stdout } = await endpoint("http://localhost:11434/v1").serve(() =>
      runCliCapture(["models", "set", "fast", "glm-5"]),
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      shape: "models-set",
      connection: "default",
      alias: "fast",
      model: "glm-5",
      previous: "qwen3-8b",
    });
    const connections = savedConnections() as Record<string, { endpoint?: string; models?: Record<string, unknown> }>;
    expect(connections.default?.models?.fast).toBe("glm-5");
    expect(connections.default?.models?.balanced).toBe("qwen3-32b");
    expect(connections.other).toEqual({ endpoint: "https://o.example.test/v1" });
  });

  test("an alias with request fields keeps them and changes the model", async () => {
    configure({ default: LOCAL });

    await endpoint("http://localhost:11434/v1").serve(() => runCliCapture(["models", "set", "reasoning", "glm-5"]));

    const models = (savedConnections().default as { models: Record<string, unknown> }).models;
    expect(models.reasoning).toEqual({ model: "glm-5", reasoning_effort: "high" });
  });

  test("adds an alias the connection did not have", async () => {
    configure({ default: LOCAL });

    const { stdout } = await endpoint("http://localhost:11434/v1").serve(() =>
      runCliCapture(["models", "set", "coder", "qwen3-8b"]),
    );

    expect(JSON.parse(stdout).previous).toBeNull();
    expect((savedConnections().default as { models: Record<string, unknown> }).models.coder).toBe("qwen3-8b");
  });

  test("--connection changes another connection", async () => {
    configure({ default: LOCAL, cloud: { endpoint: "https://api.example.test/v1", models: { fast: "gpt" } } });

    await endpoint("https://api.example.test/v1").serve(() =>
      runCliCapture(["models", "set", "fast", "glm-5", "--connection", "cloud"]),
    );

    const connections = savedConnections() as Record<string, { models: Record<string, unknown> }>;
    expect(connections.cloud?.models.fast).toBe("glm-5");
    expect(connections.default?.models.fast).toBe("qwen3-8b");
  });

  test("a model the endpoint does not list is written with one warning", async () => {
    configure({ default: LOCAL });

    const { code, stderr } = await endpoint("http://localhost:11434/v1").serve(() =>
      runCliCapture(["models", "set", "fast", "not-a-model"]),
    );

    expect(code).toBe(0);
    expect(stderr.match(/is not among the models default lists/g)).toHaveLength(1);
    expect((savedConnections().default as { models: Record<string, unknown> }).models.fast).toBe("not-a-model");
  });

  test("--no-probe checks nothing and warns of nothing", async () => {
    configure({ default: LOCAL });
    const server = endpoint("http://localhost:11434/v1");

    const { code, stderr } = await server.serve(() =>
      runCliCapture(["models", "set", "fast", "anything", "--no-probe"]),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(server.keys).toEqual([]);
  });

  test("an endpoint that cannot list is no reason to refuse", async () => {
    configure({ default: LOCAL });

    const { code } = await endpoint("http://localhost:11434/v1", { status: 500 }).serve(() =>
      runCliCapture(["models", "set", "fast", "glm-5"]),
    );

    expect(code).toBe(0);
    expect((savedConnections().default as { models: Record<string, unknown> }).models.fast).toBe("glm-5");
  });

  test("a blank model is a usage error and writes nothing", async () => {
    configure({ default: LOCAL });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const { code } = await runCliCapture(["models", "set", "fast", "  ", "--no-probe"]);

    expect(code).toBe(2);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("with no connection it points at akm setup and creates no config", async () => {
    const { code, stderr } = await runCliCapture(["models", "set", "fast", "glm-5"]);

    expect(code).toBe(78);
    expect(JSON.parse(stderr.trim()).error).toContain("akm setup");
    expect(fs.existsSync(path.join(storage.configDir, "akm", "config.json"))).toBe(false);
  });
});
