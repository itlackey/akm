// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A connection that only an `extends` base defines has its endpoint chosen by
 * that base, so it never uses a key stored on this host, whatever the store holds
 * under its name and for whichever endpoint. The base's own `$VAR` never crosses
 * over either (it is stripped when the base is read). A connection this host's
 * own file also names is the host's, and uses a key stored for its endpoint.
 *
 * `resolveTarget` decides that once and the runner carries it (`storedKey`), so a
 * runner journaled and read back answers the same whether or not the config is
 * loaded when it is dispatched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isInheritedConnection, loadUserConfig, resetConfigCache } from "../src/core/config/config";
import { writeCredential } from "../src/core/config/credentials";
import { getConfigDir, getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { buildExecution, buildExecutionFromWire, resolveExecution } from "../src/integrations/agent/execution";
import { resolveTarget } from "../src/integrations/agent/resolution";
import type { ConnectionRunner } from "../src/integrations/agent/runner";
import { materializeConnection, runExecution } from "../src/integrations/agent/runner-dispatch";
import type { ChatCompletionConfig } from "../src/llm/client";
import { clearCredentials } from "./_helpers/credentials";
import { withEnv } from "./_helpers/sandbox";

const SHARED = "https://shared.example.test/v1";
const OWN = "https://own.example.test/v1";

beforeEach(() => {
  _resetWarnOnceForTests();
  _setWarnSinkForTests(() => {});
  const base = path.join(getConfigDir(), "base-config.json");
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(
    base,
    JSON.stringify({
      configVersion: "0.9.0",
      connections: { default: { endpoint: SHARED, models: { fast: "m" }, apiKey: "$TEAM_KEY" } },
    }),
  );
  fs.writeFileSync(getConfigPath(), JSON.stringify({ configVersion: "0.9.0", extends: base }));
  resetConfigCache();
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  clearCredentials();
});

/** The key a chat call on the inherited connection would carry. */
async function keySent(): Promise<string | undefined> {
  const prepared = resolveExecution({ content: "x", config: loadUserConfig(), modelWork: true });
  const built = buildExecution(prepared.request, prepared.runner);
  const sent: Array<string | undefined> = [];
  const chat = async (connection: ChatCompletionConfig) => {
    sent.push(connection.apiKey);
    return "ok";
  };
  await withEnv({ TEAM_KEY: "the-teams-own-variable" }, () => runExecution(built, { chat }));
  return sent[0];
}

describe("an inherited connection", () => {
  test("is the base's endpoint, with the base's $VAR stripped", () => {
    const connection = loadUserConfig().connections?.default;
    expect(connection?.endpoint).toBe(SHARED);
    expect(connection).not.toHaveProperty("apiKey");
  });

  test("gets no key from a host entry of the same name stored for another endpoint", async () => {
    writeCredential({ connection: "default" }, "host-key-for-own-server", OWN);
    expect(await keySent()).toBeUndefined();
  });

  test("gets no key from a host entry in the older flat form, which names no endpoint", async () => {
    fs.writeFileSync(path.join(getConfigDir(), "credentials.json"), JSON.stringify({ default: "host-key" }));
    expect(await keySent()).toBeUndefined();
  });

  test("gets no key even from an entry stored for the base's own endpoint", async () => {
    writeCredential({ connection: "default" }, "host-key-for-shared", SHARED);
    expect(await keySent()).toBeUndefined();
  });

  test("gets the key once this host's own file names it, if it was stored for that endpoint", async () => {
    const local = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ ...local, connections: { default: { models: { fast: "m" } } } }),
    );
    resetConfigCache();
    writeCredential({ connection: "default" }, "host-key-for-own-server", OWN);
    expect(await keySent()).toBeUndefined();
    writeCredential({ connection: "default" }, "host-key-for-shared", SHARED);
    expect(await keySent()).toBe("host-key-for-shared");
  });

  describe("resolveTarget decides from the config it is given", () => {
    const storedKeyOf = (config: ReturnType<typeof loadUserConfig>): unknown =>
      (resolveTarget({ config, modelWork: true, layers: [] }) as ConnectionRunner).storedKey;

    test("the loaded config names the inherited connection; one built from it by hand names none", () => {
      const loaded = loadUserConfig();
      expect(storedKeyOf(loaded)).toBe(false);
      expect(storedKeyOf({ ...loaded })).toBeUndefined();
    });

    test("the file on disk is not asked: a config loaded before it changed keeps its answer", () => {
      const loaded = loadUserConfig();
      fs.writeFileSync(
        getConfigPath(),
        JSON.stringify({ configVersion: "0.9.0", connections: { default: { endpoint: OWN, models: { fast: "m" } } } }),
      );
      resetConfigCache();
      expect(isInheritedConnection("default")).toBe(false);
      expect(storedKeyOf(loaded)).toBe(false);
    });
  });

  describe("a runner frozen from it", () => {
    const frozen = (): ConnectionRunner => {
      const runner = resolveTarget({ config: loadUserConfig(), modelWork: true, layers: [] });
      return JSON.parse(JSON.stringify(runner)) as ConnectionRunner;
    };
    const makeLocal = () => {
      const local = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
      fs.writeFileSync(
        getConfigPath(),
        JSON.stringify({ ...local, connections: { default: { models: { fast: "m" } } } }),
      );
      resetConfigCache();
    };

    test("withholds a stored key before and after the config cache is dropped", () => {
      writeCredential({ connection: "default" }, "host-key-for-shared", SHARED);
      const runner = frozen();
      expect(runner.storedKey).toBe(false);

      expect(materializeConnection(runner).apiKey).toBeUndefined();
      resetConfigCache();
      expect(materializeConnection(runner).apiKey).toBeUndefined();
    });

    test("is dispatched the same from the journal, with no config loaded", async () => {
      writeCredential({ connection: "default" }, "host-key-for-shared", SHARED);
      const prepared = resolveExecution({ content: "x", config: loadUserConfig(), modelWork: true });
      const wire = JSON.parse(JSON.stringify({ request: prepared.request, runner: prepared.runner }));
      resetConfigCache();
      const sent: Array<string | undefined> = [];
      const chat = async (connection: ChatCompletionConfig) => {
        sent.push(connection.apiKey);
        return "ok";
      };

      await runExecution(buildExecutionFromWire(wire), { chat });

      expect(sent).toEqual([undefined]);
    });

    test("of a connection this host's own file names is eligible, and reads the key now, in either cache state", () => {
      makeLocal();
      writeCredential({ connection: "default" }, "host-key-for-shared", SHARED);
      const runner = frozen();
      expect(runner).not.toHaveProperty("storedKey");

      expect(materializeConnection(runner).apiKey).toBe("host-key-for-shared");
      resetConfigCache();
      expect(materializeConnection(runner).apiKey).toBe("host-key-for-shared");

      // The secret is not frozen: a rotated key reaches the same runner, and a removed one is gone.
      writeCredential({ connection: "default" }, "rotated-key", SHARED);
      expect(materializeConnection(runner).apiKey).toBe("rotated-key");
      clearCredentials();
      expect(materializeConnection(runner).apiKey).toBeUndefined();
    });

    test("keeps the endpoint check: a key stored for another endpoint is not sent to the frozen one", () => {
      makeLocal();
      writeCredential({ connection: "default" }, "host-key-for-own-server", OWN);
      expect(materializeConnection(frozen()).apiKey).toBeUndefined();
    });

    test("from before the field existed has no storedKey, and is eligible", () => {
      writeCredential({ connection: "default" }, "host-key-for-shared", SHARED);
      const { storedKey: _storedKey, ...older } = frozen();

      expect(materializeConnection(older as ConnectionRunner).apiKey).toBe("host-key-for-shared");
    });
  });
});
