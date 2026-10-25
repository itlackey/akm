// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A connection that only an `extends` base defines has its endpoint chosen by
 * that base, so a key stored on this host is sent to it only when the host stored
 * the key for exactly that endpoint. A shared name is not that binding, and the
 * base's own `$VAR` never crosses over (it is stripped when the base is read).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadUserConfig, resetConfigCache } from "../src/core/config/config";
import { writeCredential } from "../src/core/config/credentials";
import { getConfigDir, getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { buildExecution, resolveExecution } from "../src/integrations/agent/execution";
import { runExecution } from "../src/integrations/agent/runner-dispatch";
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

  test("gets the key this host stored for exactly that endpoint", async () => {
    writeCredential({ connection: "default" }, "host-key-for-shared", SHARED);
    expect(await keySent()).toBe("host-key-for-shared");
  });
});
