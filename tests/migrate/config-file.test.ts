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
import { normalizeConfigFile, resetConfigCache } from "../../src/core/config/config";
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
    expect(storedKeys()).toEqual({
      default: "sk-lab-from-a-file",
      cloud: "sk-cloud-literal",
      vault: "sk-from-the-secret-store",
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
    expect(notes).toContain('engines.lab.apiKeyFile: its key moves to credentials.json as "default"');
    expect(notes).toContain('engines.cloud.apiKey: its key moves to credentials.json as "cloud"');
    expect(notes).toContain('engines.vault.apiKey: its key moves to credentials.json as "vault"');
    for (const value of ["sk-lab-from-a-file", "sk-cloud-literal", "sk-from-the-secret-store"]) {
      expect(notes).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(value);
    }

    // What was applied is now current: nothing is left to do, and the connections read their keys.
    expect(normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore }).changed).toBe(false);
    expect(readCredential("default")).toBe("sk-lab-from-a-file");
  });

  test("a literal or secret-store apiKey on a connection, embedding and search.curateRerank moves under that block's name", () => {
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
      cloud: "sk-cloud-literal",
      embedding: "sk-from-the-secret-store",
      curateRerank: "sk-rerank-literal",
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
    expect(result.notes?.join("\n")).toContain('engines.lab.apiKey: its key moves to credentials.json as "default"');
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  test("a key that cannot be read moves nothing, is named, and does not stop the rest", () => {
    writeConfig({
      engines: {
        lab: llm({ apiKeyFile: path.join(storage.stashDir, "missing.key") }),
        vault: llm({ apiKey: secretRef("gone") }),
      },
      defaults: { llmEngine: "lab" },
    });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(result.applied).toBe(true);
    expect(fs.existsSync(credentialsPath())).toBe(false);
    expect(result.notes?.join("\n")).toContain("engines.lab.apiKeyFile");
    expect(result.notes?.join("\n")).toContain("engines.vault.apiKey");
    expect(result.notes?.join("\n")).toContain('under "default" in credentials.json');
    expect(Object.keys(readConfig().connections as Dict).sort()).toEqual(["default", "vault"]);
  });

  test("a key credentials.json already holds a different value for is not replaced, and the literal stays in the file", () => {
    writeCredential("cloud", "sk-already-stored");
    writeConfig({
      connections: {
        cloud: { endpoint: "https://api.example.com/v1", models: { fast: "m" }, apiKey: "sk-other-literal" },
      },
    });

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });

    expect(storedKeys()).toEqual({ cloud: "sk-already-stored" });
    expect(result.notes?.join("\n")).toContain('credentials.json already holds a different key for "cloud"');
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

  test("is moved even when the config is already current, and the entries it cannot place are listed", () => {
    writeConfig({ connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } } });
    fs.writeFileSync(modelsFile(), MODELS);
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const dry = normalizeConfigFile(getConfigPath(), { apply: false, resolveFromStore });
    expect(dry).toMatchObject({ changed: true, applied: false });
    expect(fs.existsSync(modelsFile())).toBe(true);

    const result = normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore });
    expect(result).toMatchObject({ changed: true, applied: true });
    expect(fs.existsSync(modelsFile())).toBe(false);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(result.backupPath).toBeUndefined();
    expect(result.notes?.join("\n")).toContain("models.json fast.lab: names no configured connection or harness");
  });

  test("a config with no models.json and nothing to convert is current", () => {
    writeConfig({ connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } } });
    expect(normalizeConfigFile(getConfigPath(), { apply: true, resolveFromStore })).toMatchObject({
      changed: false,
      applied: false,
    });
  });
});
