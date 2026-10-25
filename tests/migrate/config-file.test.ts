// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The migrator's config step: `engines` converted to `connections` /
 * `harnesses`, every key akm no longer reads from config.json filed in
 * credentials.json, and the entries the reader drops kept as written. Each test
 * runs in an isolated config, cache and data directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, normalizeConfigFile, resetConfigCache } from "../../src/core/config/config";
import { readCredential, writeCredential } from "../../src/core/config/credentials";
import { getCacheDir, getConfigDir, getConfigPath } from "../../src/core/paths";
import { type IsolatedAkmStorage, withEnvSync, withIsolatedAkmStorage } from "../_helpers/sandbox";

type Dict = Record<string, unknown>;

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const llm = (extra: Dict = {}): Dict => ({
  kind: "llm",
  endpoint: "http://lab:8080/v1/chat/completions",
  model: "qwen3-32b",
  ...extra,
});

function writeConfig(value: Dict): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.9.0", ...value }, null, 2)}\n`);
}

const readConfig = (): Dict => JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;
const credentialsPath = (): string => path.join(getConfigDir(), "credentials.json");
const storedKeys = (): Dict => JSON.parse(fs.readFileSync(credentialsPath(), "utf8")) as Dict;

/** A `${secrets/...}` reference, which a source file cannot write without tripping the template-string lint. */
const secretRef = (name: string): string => ["$", "{secrets/", name, "}"].join("");

const SECRETS: Record<string, string> = { shared: "sk-from-the-secret-store" };
const resolveFromStore = (ref: string): string | null => SECRETS[ref.replace(/^secrets\//, "")] ?? null;

function keyFile(name: string, contents: string): string {
  const file = path.join(storage.stashDir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe("the keys an engines config holds that akm no longer reads", () => {
  test("an apiKeyFile, a literal apiKey and a secret-store apiKey are filed under the connections they became, then removed", () => {
    writeConfig({
      engines: {
        lab: llm({ apiKeyFile: keyFile("lab.key", "sk-lab-from-a-file\n") }),
        cloud: llm({ apiKey: "sk-cloud-literal" }),
        vault: llm({ apiKey: secretRef("shared") }),
      },
      defaults: { llmEngine: "lab" },
    });
    const original = fs.readFileSync(getConfigPath(), "utf8");

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(result.applied).toBe(true);
    // The default engine is renamed to `default`; its key is filed under that name.
    const lab = "http://lab:8080/v1/chat/completions";
    expect(storedKeys()).toEqual({
      connections: {
        default: { key: "sk-lab-from-a-file", endpoint: lab },
        cloud: { key: "sk-cloud-literal", endpoint: lab },
        vault: { key: "sk-from-the-secret-store", endpoint: lab },
      },
    });
    expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(result.credentials).toEqual(["default", "cloud", "vault"]);

    const written = readConfig();
    expect(written.engines).toBeUndefined();
    const connections = written.connections as Record<string, Dict>;
    expect(Object.keys(connections).sort()).toEqual(["cloud", "default", "vault"]);
    for (const connection of Object.values(connections)) {
      expect(connection).not.toHaveProperty("apiKey");
      expect(connection).not.toHaveProperty("apiKeyFile");
    }
    // The backup of the file as it was keeps the original, so nothing is lost.
    expect(fs.readFileSync(result.backupPath as string, "utf8")).toBe(original);

    // One note per key, naming its place and its entry, never the value.
    const notes = (result.notes ?? []).join("\n");
    expect(notes).toContain(
      'engines.lab.apiKeyFile: its key moves to credentials.json for "default" at http://lab:8080/v1/chat/completions',
    );
    expect(notes).toContain('engines.cloud.apiKey: its key moves to credentials.json for "cloud"');
    expect(notes).toContain('engines.vault.apiKey: its key moves to credentials.json for "vault"');
    for (const value of ["sk-lab-from-a-file", "sk-cloud-literal", "sk-from-the-secret-store"]) {
      expect(notes).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(value);
    }

    // What was applied is now current: nothing is left to do, and the connections read their keys.
    expect(normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore }).changed).toBe(false);
    expect(readCredential({ connection: "default" }, "http://lab:8080/v1/chat/completions")).toBe("sk-lab-from-a-file");
  });

  test("a literal or secret-store apiKey on a connection, embedding and search.curateRerank moves to credentials.json for that block and its endpoint", () => {
    writeConfig({
      connections: {
        cloud: { endpoint: "https://api.example.com/v1", models: { fast: "m" }, apiKey: "sk-cloud-literal" },
        env: { endpoint: "https://env.example.com/v1", models: { fast: "m" }, apiKey: "$ENV_KEY" },
      },
      embedding: { model: "embed", endpoint: "https://embed.example.com/v1", apiKey: secretRef("shared") },
      search: { curateRerank: { endpoint: "https://rerank.example.com/v1", model: "r", apiKey: "sk-rerank-literal" } },
    });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(storedKeys()).toEqual({
      connections: { cloud: { key: "sk-cloud-literal", endpoint: "https://api.example.com/v1" } },
      services: {
        embedding: { key: "sk-from-the-secret-store", endpoint: "https://embed.example.com/v1" },
        curateRerank: { key: "sk-rerank-literal", endpoint: "https://rerank.example.com/v1" },
      },
    });
    const written = readConfig();
    const connections = written.connections as Record<string, Dict>;
    expect(connections.cloud).not.toHaveProperty("apiKey");
    // A reference stays: it is how the connection reads its key.
    expect(connections.env?.apiKey).toBe("$ENV_KEY");
    expect(written.embedding).not.toHaveProperty("apiKey");
    expect((written.search as Dict).curateRerank).not.toHaveProperty("apiKey");
    expect(result.credentials).toEqual(["cloud", "embedding", "curateRerank"]);
  });

  test("--dry-run lists the entries and the notes, and writes nothing", () => {
    writeConfig({
      engines: { lab: llm({ apiKey: "sk-cloud-literal" }) },
      defaults: { llmEngine: "lab" },
    });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const result = normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore });

    expect(result).toMatchObject({ changed: true, applied: false, credentials: ["default"] });
    expect(result.notes?.join("\n")).toContain('engines.lab.apiKey: its key moves to credentials.json for "default"');
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  test("a secret reference that does not resolve stays on the connection as the apiKey it was, named in the note", () => {
    writeConfig({ engines: { vault: llm({ apiKey: secretRef("gone") }) } });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(result.applied).toBe(true);
    expect(fs.existsSync(credentialsPath())).toBe(false);
    expect(((readConfig().connections as Record<string, Dict>).vault as Dict).apiKey).toBe(secretRef("gone"));
    const notes = result.notes?.join("\n") ?? "";
    expect(notes).toContain(`engines.vault.apiKey: the secret store reference ${secretRef("gone")} could not be read`);
    expect(notes).toContain("It stays on the connection as apiKey.");
    // The next run reads it from the connection and finds nothing more to do.
    expect(normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore })).toMatchObject({ changed: false });
  });

  test("a key file that cannot be read yet stays on the connection as the apiKeyFile it was, and is still to do", () => {
    const missing = path.join(storage.stashDir, "missing.key");
    writeConfig({ engines: { lab: llm({ apiKeyFile: missing }) }, defaults: { llmEngine: "lab" } });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(result.applied).toBe(true);
    expect(fs.existsSync(credentialsPath())).toBe(false);
    const connection = (readConfig().connections as Record<string, Dict>).default as Dict;
    expect(connection).not.toHaveProperty("apiKey");
    expect(connection.apiKeyFile).toBe(missing);
    const notes = result.notes?.join("\n") ?? "";
    expect(notes).toContain(
      `engines.lab.apiKeyFile: its key file ${missing} could not be read, so no key moves and this is still to do.`,
    );
    expect(notes).toContain("It stays on the connection as apiKeyFile.");
    // akm never reads the file or sends its path: the connection is read as one with no key.
    resetConfigCache();
    const loaded = loadConfig().connections?.default;
    expect(loaded?.apiKeyFile).toBe(missing);
  });

  test("a later run moves the key once the file can be read, and removes the reference", () => {
    const keyPath = path.join(storage.stashDir, "later.key");
    writeConfig({ engines: { lab: llm({ apiKeyFile: keyPath }) }, defaults: { llmEngine: "lab" } });
    normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });
    expect(fs.existsSync(credentialsPath())).toBe(false);

    // The mount comes back.
    fs.writeFileSync(keyPath, "sk-from-the-late-file\n");
    resetConfigCache();
    const second = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(second.applied).toBe(true);
    expect(second.notes?.join("\n")).toContain(
      'connections.default.apiKeyFile: its key moves to credentials.json for "default"',
    );
    expect(storedKeys()).toEqual({
      connections: { default: { key: "sk-from-the-late-file", endpoint: "http://lab:8080/v1/chat/completions" } },
    });
    expect((readConfig().connections as Record<string, Dict>).default).not.toHaveProperty("apiKeyFile");
    expect(normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore }).changed).toBe(false);
  });

  test("an engine's literal key that credentials.json holds a different key for stays on the connection, and is not replaced", () => {
    writeCredential({ connection: "cloud" }, "sk-already-stored", "http://lab:8080/v1/chat/completions");
    writeConfig({ engines: { cloud: llm({ apiKey: "sk-cloud-literal" }) } });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(storedKeys()).toEqual({
      connections: { cloud: { key: "sk-already-stored", endpoint: "http://lab:8080/v1/chat/completions" } },
    });
    expect(((readConfig().connections as Record<string, Dict>).cloud as Dict).apiKey).toBe("sk-cloud-literal");
    const notes = result.notes?.join("\n") ?? "";
    expect(notes).toContain('credentials.json already holds a different key or endpoint for "cloud"');
    expect(notes).toContain("It stays on the connection as apiKey.");
    expect(notes).not.toContain("sk-cloud-literal");
    expect(result.credentials).toBeUndefined();
  });

  test("a key credentials.json already holds a different value for is not replaced, and the literal stays in the file", () => {
    writeCredential({ connection: "cloud" }, "sk-already-stored", "https://api.example.com/v1");
    writeConfig({
      connections: {
        cloud: { endpoint: "https://api.example.com/v1", models: { fast: "m" }, apiKey: "sk-other-literal" },
      },
    });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(storedKeys()).toEqual({
      connections: { cloud: { key: "sk-already-stored", endpoint: "https://api.example.com/v1" } },
    });
    expect(result.notes?.join("\n")).toContain(
      'credentials.json already holds a different key or endpoint for "cloud"',
    );
    expect(((readConfig().connections as Record<string, Dict>).cloud as Dict).apiKey).toBe("sk-other-literal");
  });

  test("a credentials.json that is not a JSON object stops the step and loses no key", () => {
    fs.writeFileSync(credentialsPath(), "not json");
    writeConfig({ engines: { lab: llm({ apiKey: "sk-cloud-literal" }) }, defaults: { llmEngine: "lab" } });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    expect(() => normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore })).toThrow(
      /credentials\.json is not a JSON object|refusing to overwrite/,
    );

    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(fs.readFileSync(credentialsPath(), "utf8")).toBe("not json");
  });

  test("AKM_ENGINE_<N>_API_KEY and AKM_LLM_API_KEY, set in the environment, become the connection's $VAR key", () => {
    writeConfig({ engines: { lab: llm(), other: llm() }, defaults: { llmEngine: "lab" } });

    withEnvSync({ AKM_LLM_API_KEY: "a", AKM_ENGINE_OTHER_API_KEY: "b" }, () => {
      normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });
    });

    const connections = readConfig().connections as Record<string, Dict>;
    expect(connections.default?.apiKey).toBe("$AKM_LLM_API_KEY");
    expect(connections.other?.apiKey).toBe("$AKM_ENGINE_OTHER_API_KEY");
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });
});

describe("a key credentials.json holds in the older flat form", () => {
  const OLD = "https://old.invalid/v1";
  const CURRENT = "https://new.invalid/v1";
  const writeFlat = (value: Dict): void => fs.writeFileSync(credentialsPath(), JSON.stringify(value));

  test("does not replace the key a later setup or rotation stored for the same connection", () => {
    writeFlat({ default: "SYNTHETIC_OLD_KEY" });
    // What setup does when the user rotates the key or moves the endpoint: the typed entry is written beside the old one.
    writeCredential({ connection: "default" }, "SYNTHETIC_CURRENT_KEY", CURRENT);
    writeConfig({ connections: { default: { endpoint: CURRENT, models: { fast: "m" } } } });
    const before = storedKeys();

    const dry = normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore });
    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(dry.notes?.join("\n")).toContain('connection "default" already holds a different key or endpoint');
    expect(result.notes?.join("\n")).toContain('connection "default" already holds a different key or endpoint');
    expect(result.credentials).toBeUndefined();
    expect(result.credentialsBackupPath).toBeUndefined();
    expect(storedKeys()).toEqual(before);
    expect(readCredential({ connection: "default" }, CURRENT)).toBe("SYNTHETIC_CURRENT_KEY");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_");
  });

  test("is filed when the connection has no key yet, after the store is copied", () => {
    writeFlat({ default: "SYNTHETIC_OLD_KEY" });
    const original = fs.readFileSync(credentialsPath(), "utf8");
    writeConfig({ connections: { default: { endpoint: OLD, models: { fast: "m" } } } });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(result.credentials).toEqual(["default"]);
    expect(storedKeys()).toEqual({ connections: { default: { key: "SYNTHETIC_OLD_KEY", endpoint: OLD } } });
    expect(fs.readFileSync(result.credentialsBackupPath as string, "utf8")).toBe(original);
  });

  test("meets the key the same run moves out of the config by the one policy: the config's key is filed and the older entry stays", () => {
    writeFlat({ cloud: "SYNTHETIC_OLD_KEY" });
    writeConfig({ connections: { cloud: { endpoint: OLD, models: { fast: "m" }, apiKey: "SYNTHETIC_CONFIG_KEY" } } });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(storedKeys()).toEqual({
      cloud: "SYNTHETIC_OLD_KEY",
      connections: { cloud: { key: "SYNTHETIC_CONFIG_KEY", endpoint: OLD } },
    });
    expect(result.notes?.join("\n")).toContain('connection "cloud" already holds a different key or endpoint');
  });
});

describe("the entries the reader drops", () => {
  const draft = { models: { fast: "m" }, top_p: 0.9 };
  const cursor = { bin: "/opt/cursor", args: ["--x"] };

  test("stay in the file exactly as written, each with a note on what to fix", () => {
    writeConfig({
      engines: { lab: llm() },
      defaults: { llmEngine: "lab" },
      connections: { draft },
      harnesses: { cursor },
    });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    const written = readConfig();
    expect((written.connections as Dict).draft).toEqual(draft);
    expect((written.harnesses as Dict).cursor).toEqual(cursor);
    expect(Object.keys(written.connections as Dict).sort()).toEqual(["default", "draft"]);
    const notes = (result.notes ?? []).join("\n");
    expect(notes).toMatch(/connections\.draft: kept as written.*endpoint/);
    expect(notes).toMatch(/harnesses\.cursor: kept as written.*platform/);
  });

  test("include one whose name breaks the naming rule: kept as written, with a note naming it", () => {
    const lab = { endpoint: "http://lab:8080/v1", models: { fast: "m" } };
    writeConfig({
      connections: { "My Lab": lab, lab },
      harnesses: { Claude_Work: { platform: "claude" } },
    });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    const written = readConfig();
    expect((written.connections as Dict)["My Lab"]).toEqual(lab);
    expect((written.harnesses as Dict).Claude_Work).toEqual({ platform: "claude" });
    const notes = (result.notes ?? []).join("\n");
    expect(notes).toContain(
      "connections.My Lab: kept as written, and ignored by akm because its name breaks the naming rule",
    );
    expect(notes).toContain("harnesses.Claude_Work: kept as written");
  });

  test("are not claimed when an extends base completes them: no note, nothing kept as an orphan", () => {
    fs.writeFileSync(
      path.join(path.dirname(getConfigPath()), "base.json"),
      JSON.stringify({ configVersion: "0.9.0", connections: { lab: { endpoint: "http://lab:8080/v1" } } }),
    );
    writeConfig({ extends: "base.json", connections: { lab: { models: { fast: "m" } } } });

    const result = normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore });

    expect(result.notes?.join("\n") ?? "").not.toContain("connections.lab");
  });

  test("are kept when they are all the file holds", () => {
    writeConfig({ connections: { draft }, bundles: {} });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect((readConfig().connections as Dict).draft).toEqual(draft);
    expect(result.notes?.join("\n")).toContain("connections.draft: kept as written");
  });
});

describe("the retired models.json", () => {
  const MODELS = JSON.stringify({ version: 1, aliases: { fast: { lab: "qwen3-8b" }, balanced: { "*": "qwen3-32b" } } });
  const modelsFile = (): string => path.join(getConfigDir(), "models.json");

  test("is folded into the models of what it named, then moved to the config backups and removed", () => {
    writeConfig({ engines: { lab: llm() }, defaults: { llmEngine: "lab" } });
    fs.writeFileSync(modelsFile(), MODELS);

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(((readConfig().connections as Record<string, Dict>).default as Dict).models).toMatchObject({
      fast: "qwen3-8b",
      balanced: "qwen3-32b",
    });
    expect(fs.existsSync(modelsFile())).toBe(false);
    const moved = result.modelsFileBackupPath as string;
    expect(path.dirname(moved)).toBe(path.join(getCacheDir(), "config-backups"));
    expect(path.basename(moved)).toMatch(/^models\.json\./);
    expect(fs.readFileSync(moved, "utf8")).toBe(MODELS);
    expect(result.notes?.join("\n")).toContain("models.json");
  });

  test("is folded into a config already in the connections form, then moved; the entries it cannot place are listed", () => {
    writeConfig({ connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } } });
    fs.writeFileSync(
      modelsFile(),
      JSON.stringify({
        version: 1,
        aliases: { fast: { lab: "ignored" }, balanced: { "*": "qwen3-32b" }, coder: { nowhere: "x" } },
      }),
    );

    const dry = normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore });
    expect(dry).toMatchObject({ changed: true, applied: false, keys: ["connections"] });
    expect(fs.existsSync(modelsFile())).toBe(true);

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });
    expect(result).toMatchObject({ changed: true, applied: true });
    expect(fs.existsSync(modelsFile())).toBe(false);
    // The config's own `fast` stands; the wildcard fills `balanced`.
    expect(((readConfig().connections as Record<string, Dict>).lab as Dict).models).toEqual({
      fast: "m",
      balanced: "qwen3-32b",
    });
    expect(result.backupPath).toBeDefined();
    const notes = result.notes?.join("\n") ?? "";
    expect(notes).toContain("models.json fast.lab: the config already names a model for it");
    expect(notes).toContain("models.json coder.nowhere: names no configured connection or harness");
  });

  test("is folded into a connection only an extends base defines, as a partial entry the base completes", () => {
    fs.writeFileSync(
      path.join(path.dirname(getConfigPath()), "base.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        connections: { shared: { endpoint: "http://shared:1/v1", models: { fast: "s-fast" } } },
      }),
    );
    writeConfig({
      extends: "base.json",
      connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } },
    });
    fs.writeFileSync(
      modelsFile(),
      JSON.stringify({
        version: 1,
        aliases: { reasoning: { shared: "s-big" }, balanced: { "*": "wild" }, fast: { shared: "ignored" } },
      }),
    );
    resetConfigCache();
    const sharedBefore = loadConfig().connections?.shared?.models;
    expect(sharedBefore).toEqual({ fast: "s-fast", reasoning: "s-big", balanced: "wild" });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(fs.existsSync(modelsFile())).toBe(false);
    // The local file carries what only the overlay put there; the base still completes the entry.
    expect((readConfig().connections as Record<string, Dict>).shared).toEqual({
      models: { reasoning: "s-big", balanced: "wild" },
    });
    resetConfigCache();
    expect(loadConfig().connections?.shared?.models).toEqual(sharedBefore);
    expect(loadConfig().connections?.lab?.models).toEqual({ fast: "m", balanced: "wild" });
    const notes = result.notes?.join("\n") ?? "";
    expect(notes).not.toContain("names no configured connection");
    expect(notes).toContain("models.json fast.shared: the config already names a model for it");
  });

  test("is moved even when it places nothing, and the config is then left as it was", () => {
    writeConfig({ connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } } });
    fs.writeFileSync(modelsFile(), JSON.stringify({ version: 1, aliases: { coder: { nowhere: "x" } } }));
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(result).toMatchObject({ changed: true, applied: true });
    expect(result.backupPath).toBeUndefined();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(fs.existsSync(modelsFile())).toBe(false);
    expect(result.notes?.join("\n")).toContain("models.json coder.nowhere: names no configured connection or harness");
  });

  test("a config with no models.json and nothing to convert is current", () => {
    writeConfig({ connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } } });
    expect(normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore })).toMatchObject({
      changed: false,
      applied: false,
    });
  });
});
