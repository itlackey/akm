// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #953 — engine-resolution.ts's dispatch boundary (the `akm improve` / agent
 * path) now resolves a `secret://<name>` apiKey reference through the real
 * akm secret store, the same way `llm/client.ts` and `embedders/remote.ts`
 * already did. Integration-classified (ORG-03/04/05/06): `setSecret` performs
 * a real atomic write under a sandboxed stash, and resolution reads it back
 * through the real store resolver (`resolveSecretFromStore`).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setSecret } from "../../src/commands/env/secret";
import {
  collectEngineCredentialValues,
  materializeLlmConnection,
  resolveEngine,
  resolveLlmEngineUse,
} from "../../src/integrations/agent/engine-resolution";
import { materializeLlmRunnerConnection } from "../../src/integrations/agent/runner";
import { withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

const config = {
  configVersion: "0.9.0" as const,
  engines: {
    lab: {
      kind: "llm" as const,
      endpoint: "https://example.test/v1/chat/completions",
      model: "base-model",
      apiKey: "secret://lab-api-key",
    },
  },
  defaults: { llmEngine: "lab" },
};

describe("engine-resolution secret-store credential (#953)", () => {
  test("materializeLlmConnection resolves a secret:// apiKey from the store at dispatch", () => {
    const storage = withIsolatedAkmStorage();
    try {
      setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("store-secret-value"));
      const resolved = resolveLlmEngineUse(config, [{ engine: "lab" }]);
      expect(resolved.apiKeySecretRef).toBe("secret://lab-api-key");
      expect(resolved.credential).toBeUndefined();
      expect(materializeLlmConnection(resolved).apiKey).toBe("store-secret-value");
    } finally {
      storage.cleanup();
    }
  });

  test("collectEngineCredentialValues includes a secret-store-backed engine's current value for redaction", () => {
    const storage = withIsolatedAkmStorage();
    try {
      setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("collect-me-store-secret"));
      const values = collectEngineCredentialValues(config);
      expect(values).toContain("collect-me-store-secret");
    } finally {
      storage.cleanup();
    }
  });

  test("resolveEngine's lowered llm runner carries apiKeySecretRef through to dispatch", () => {
    const storage = withIsolatedAkmStorage();
    try {
      setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("dispatch-store-secret"));
      const runner = resolveEngine("lab", config);
      expect(runner.kind).toBe("llm");
      if (runner.kind !== "llm") throw new Error("fixture must lower to llm");
      expect(runner.apiKeySecretRef).toBe("secret://lab-api-key");
      expect(materializeLlmRunnerConnection(runner).apiKey).toBe("dispatch-store-secret");
    } finally {
      storage.cleanup();
    }
  });

  // #953 addendum — the tests above resolve the store under the sandboxed
  // stash but never pin that this resolution is independent of the
  // operator's home directory. A scheduled/OpenPalm-style invocation runs
  // with `$HOME` pointed somewhere the akm config/stash/secrets do NOT
  // live (a service account home, a container's default `/root`, etc.),
  // while `AKM_BUNDLE_DIR`/`XDG_*_HOME` still name the real stash — exactly
  // what `withIsolatedAkmStorage` already sets up. This proves `secret://`
  // resolution never falls back to `$HOME` for anything.
  test("secret:// resolves and dispatches with $HOME pointed at a foreign, akm-less directory (scheduled/OpenPalm context, #953)", async () => {
    const storage = withIsolatedAkmStorage();
    const foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-openpalm-home-"));
    try {
      setSecret(path.join(storage.stashDir, "secrets", "lab-api-key"), Buffer.from("openpalm-store-secret"));
      await withEnv({ HOME: foreignHome }, () => {
        const resolved = resolveLlmEngineUse(config, [{ engine: "lab" }]);
        expect(resolved.apiKeySecretRef).toBe("secret://lab-api-key");
        expect(resolved.credential).toBeUndefined();
        expect(materializeLlmConnection(resolved).apiKey).toBe("openpalm-store-secret");

        const runner = resolveEngine("lab", config);
        if (runner.kind !== "llm") throw new Error("fixture must lower to llm");
        expect(materializeLlmRunnerConnection(runner).apiKey).toBe("openpalm-store-secret");
      });
    } finally {
      fs.rmSync(foreignHome, { recursive: true, force: true });
      storage.cleanup();
    }
  });
});
