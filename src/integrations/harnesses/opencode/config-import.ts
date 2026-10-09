// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode LLM-config importer (migrated from `setup/harness-config-import.ts`,
 * #564).
 *
 * Detects an OpenCode installation (filesystem only, no network) and reads its
 * config to extract the connection details of the user's SELECTED model. It is
 * a pure reader, so one implementation serves OpenCode 1 and 2 configs and
 * writes nothing into either. API key VALUES are never stored: only the name
 * of the environment variable a `{env:NAME}` / `$NAME` reference points at.
 * A literal key or a `{file:path}` reference yields no credential (a literal
 * must not be copied, and akm's setup has no file-reference slot to carry it).
 *
 * Config shapes (checked against OpenCode 1.18.34 and 2.0.26):
 *   - files: `opencode.json` / `opencode.jsonc` in the global config dir and
 *     the project (cwd, `.opencode/`); V1 also reads a legacy `config.json`.
 *   - `model`: `"provider/model"` string (V1, and accepted by V2) or
 *     `{providerID, model}` (V2).
 *   - V1 providers: `provider.<id>.options.{baseURL,apiKey}`, `models.<k>.id`.
 *   - V2 providers: `providers.<id>.settings.{baseURL,apiKey}`, `env: [NAME]`,
 *     `models.<k>.modelID`. V2 also accepts the V1 `provider` key, so both are
 *     read per file and merged by provider id.
 * The provider is the one `model` names. When no model is selected, or it
 * names a provider the config does not define, nothing else is substituted.
 */

import fs from "node:fs";
import path from "node:path";
import { asNonEmptyString, asRecord, parseJsonc, toErrorMessage } from "../../../core/common";
import { warnOnce } from "../../../core/warn";
import { type HarnessConfigImporter, type HarnessLLMConfig, homeDir } from "../shared";

type Json = Record<string, unknown>;

interface ProviderEntry {
  baseUrl?: string;
  apiKey?: string;
  env?: string[];
  /** model key -> the model id the API is called with */
  models: Map<string, string | undefined>;
}

const asObject = asRecord;
const str = asNonEmptyString;

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homeDir(), ".config"), "opencode");
}

/** Config files in increasing precedence: global, explicit env overrides, then the project. */
function candidateFiles(): string[] {
  const dirs = [configDir(), process.env.OPENCODE_CONFIG_DIR].filter((d): d is string => !!d);
  const files = [path.join(configDir(), "config.json"), path.join(homeDir(), ".opencode", "config.json")];
  for (const dir of dirs) files.push(path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc"));
  if (process.env.OPENCODE_CONFIG) files.push(process.env.OPENCODE_CONFIG);
  const cwd = process.cwd();
  files.push(
    path.join(cwd, "opencode.json"),
    path.join(cwd, "opencode.jsonc"),
    path.join(cwd, ".opencode", "config.json"),
    path.join(cwd, ".opencode", "opencode.json"),
    path.join(cwd, ".opencode", "opencode.jsonc"),
  );
  return [...new Set(files)];
}

/** `provider/model` or `{providerID, model}` -> the selection, or undefined when none is made. */
function selectedModel(model: unknown): { providerId: string; modelKey: string } | undefined {
  const obj = asObject(model);
  if (obj) {
    const providerId = str(obj.providerID);
    const modelKey = str(obj.model);
    return providerId && modelKey ? { providerId, modelKey } : undefined;
  }
  const text = str(model);
  const slash = text?.indexOf("/") ?? -1;
  if (!text || slash < 1 || slash === text.length - 1) return undefined;
  return { providerId: text.slice(0, slash), modelKey: text.slice(slash + 1) };
}

/**
 * Add one file's providers, from both the V2 (`providers`/`settings`) and V1
 * (`provider`/`options`) keys, into `out`: a later file's values win per field.
 */
function readProviders(raw: Json, out: Map<string, ProviderEntry>): void {
  for (const [key, settingsKey] of [
    ["provider", "options"],
    ["providers", "settings"],
  ] as const) {
    const map = asObject(raw[key]);
    if (!map) continue;
    for (const [id, value] of Object.entries(map)) {
      const p = asObject(value);
      if (!p) continue;
      const settings = asObject(p[settingsKey]);
      const entry = out.get(id) ?? { models: new Map<string, string | undefined>() };
      entry.baseUrl = str(settings?.baseURL) ?? str(settings?.baseUrl) ?? entry.baseUrl;
      entry.apiKey = str(settings?.apiKey) ?? entry.apiKey;
      if (Array.isArray(p.env)) entry.env = p.env.filter((e): e is string => typeof e === "string");
      for (const [modelKey, m] of Object.entries(asObject(p.models) ?? {})) {
        const mo = asObject(m);
        entry.models.set(modelKey, str(mo?.modelID) ?? str(mo?.id) ?? entry.models.get(modelKey));
      }
      out.set(id, entry);
    }
  }
}

/** The env var an apiKey reference names: `{env:NAME}`, `$NAME` or `${NAME}`. Literals and `{file:}` give undefined. */
function envVarOf(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  const m = /^(?:\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))$/.exec(
    apiKey,
  );
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

/** Imports the selected model's LLM connection from an OpenCode 1 or 2 config. */
export const openCodeImporter: HarnessConfigImporter = {
  harnessName: "OpenCode",
  detect() {
    return fs.existsSync(configDir()) || fs.existsSync(path.join(homeDir(), ".opencode"));
  },
  importConfig() {
    let model: unknown;
    let read = false;
    const providers = new Map<string, ProviderEntry>();
    for (const filePath of candidateFiles()) {
      let raw: Json | undefined;
      try {
        if (!fs.existsSync(filePath)) continue;
        raw = asObject(parseJsonc(fs.readFileSync(filePath, "utf8")));
      } catch (error) {
        warnOnce(
          `opencode-config-import:${filePath}`,
          `OpenCode config ${filePath} could not be read (${toErrorMessage(error)}); skipped.`,
        );
        continue;
      }
      if (!raw) continue;
      read = true;
      if (raw.model !== undefined) model = raw.model;
      readProviders(raw, providers);
    }
    if (!read) return null;

    const result: HarnessLLMConfig = { harnessName: "OpenCode" };
    const selection = selectedModel(model);
    if (!selection) return result;
    const entry = providers.get(selection.providerId);
    result.provider = selection.providerId;
    result.model = entry?.models.get(selection.modelKey) ?? selection.modelKey;
    if (entry?.baseUrl) result.baseUrl = entry.baseUrl;
    const envVar = envVarOf(entry?.apiKey) ?? (!entry?.apiKey && entry?.env?.length === 1 ? entry.env[0] : undefined);
    if (envVar) result.apiKeyEnvVar = envVar;
    else if (entry?.apiKey) {
      warnOnce(
        `opencode-config-import:credential:${selection.providerId}`,
        `OpenCode provider "${selection.providerId}" has an API key that is not an environment-variable reference; it was not imported. Export the key as an environment variable and reference it there.`,
      );
    }
    return result;
  },
};
