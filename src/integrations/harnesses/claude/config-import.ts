// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Claude Code LLM-config importer (migrated from `setup/harness-config-import.ts`,
 * #563).
 *
 * Detects a Claude Code installation (filesystem only, no network) and reads
 * its config to extract LLM connection details. API key VALUES are never
 * stored — only the env var name that holds them. The pluggable registry
 * (`HARNESS_CONFIG_IMPORTERS`) and the OpenCode importer stay in
 * `setup/harness-config-import.ts`, which imports this importer back.
 *
 * Behaviour-preserving relocation.
 */

import fs from "node:fs";
import path from "node:path";
import type { HarnessConfigImporter } from "../../../setup/harness-config-import";
import { homeDir } from "../shared";

/**
 * Imports LLM config from a Claude Code installation.
 *
 * Claude Code stores settings in `~/.claude/settings.json` or `~/.claude.json`.
 * The model field may appear at the root or under `env.ANTHROPIC_MODEL`.
 * The API key is always `ANTHROPIC_API_KEY`.
 */
export const claudeCodeImporter: HarnessConfigImporter = {
  harnessName: "Claude Code",
  detect() {
    const home = homeDir();
    // Claude Code is installed if the ~/.claude/ directory exists
    return fs.existsSync(path.join(home, ".claude"));
  },
  importConfig() {
    const home = homeDir();
    // Try ~/.claude/settings.json, then ~/.claude.json
    const candidates = [path.join(home, ".claude", "settings.json"), path.join(home, ".claude.json")];
    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
        // Claude Code settings: model may be at root or nested under env
        const envBlock = raw.env as Record<string, unknown> | undefined;
        const model =
          typeof raw.model === "string"
            ? raw.model
            : typeof envBlock?.ANTHROPIC_MODEL === "string"
              ? String(envBlock.ANTHROPIC_MODEL)
              : undefined;
        return {
          harnessName: "Claude Code",
          provider: "anthropic",
          model: model ?? "claude-sonnet-4-5",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        };
      } catch {
        // try next candidate
      }
    }
    // ~/.claude exists but no readable settings — still return basic Anthropic config
    return {
      harnessName: "Claude Code",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
    };
  },
};
