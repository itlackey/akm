// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode LLM-config importer (migrated from `setup/harness-config-import.ts`,
 * #564).
 *
 * Detects an OpenCode installation (filesystem only, no network) and reads its
 * config to extract LLM connection details. API key VALUES are never stored —
 * only the env var name that holds them. The pluggable registry
 * (`HARNESS_CONFIG_IMPORTERS`) and the Claude importer stay in their respective
 * modules; `setup/harness-config-import.ts` imports this importer back.
 *
 * Behaviour-preserving relocation.
 */

import fs from "node:fs";
import path from "node:path";
import type { HarnessConfigImporter } from "../../../setup/harness-config-import";
import { homeDir } from "../shared";

/**
 * Imports LLM config from an OpenCode installation.
 *
 * OpenCode stores config in `~/.config/opencode/config.json` or
 * `~/.opencode/config.json`. Its schema has a `providers` array and a
 * `model` field. API keys in providers appear as `$ENV_VAR_NAME` references.
 */
export const openCodeImporter: HarnessConfigImporter = {
  harnessName: "OpenCode",
  detect() {
    const home = homeDir();
    return fs.existsSync(path.join(home, ".config", "opencode")) || fs.existsSync(path.join(home, ".opencode"));
  },
  importConfig() {
    const home = homeDir();
    const candidates = [
      path.join(home, ".config", "opencode", "config.json"),
      path.join(home, ".opencode", "config.json"),
      path.join(process.cwd(), ".opencode", "config.json"),
    ];
    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
        // OpenCode config shape: { model?: string, providers?: Array<{id, apiKey, baseUrl, ...}> }
        const model = typeof raw.model === "string" ? raw.model : undefined;

        // Extract provider info from the first entry in the providers array
        let provider: string | undefined;
        let baseUrl: string | undefined;
        let apiKeyEnvVar: string | undefined;
        const providers = Array.isArray(raw.providers) ? (raw.providers as Record<string, unknown>[]) : [];
        if (providers.length > 0) {
          const first = providers[0];
          provider = typeof first?.id === "string" ? first.id : undefined;
          baseUrl =
            typeof first?.baseUrl === "string"
              ? first.baseUrl
              : typeof first?.base_url === "string"
                ? first.base_url
                : undefined;
          // apiKey is an env var reference like "$OPENAI_API_KEY" — extract the var name
          const apiKeyVal = typeof first?.apiKey === "string" ? first.apiKey : "";
          if (apiKeyVal.startsWith("$")) {
            apiKeyEnvVar = apiKeyVal.slice(1);
          }
        }

        return {
          harnessName: "OpenCode",
          provider,
          model,
          baseUrl,
          apiKeyEnvVar,
        };
      } catch {
        // try next candidate
      }
    }
    return null;
  },
};
