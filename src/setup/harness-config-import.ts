// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pluggable registry of LLM config importers for supported agent harnesses.
 *
 * Each importer detects whether a harness is installed (filesystem only,
 * no network) and, if so, reads its config to extract LLM connection details.
 * API key VALUES are never stored — only the env var names that hold them.
 *
 * To add a new harness: implement {@link HarnessConfigImporter} and append it
 * to {@link HARNESS_CONFIG_IMPORTERS}.
 *
 * NOTE: The `detect()` method in each importer overlaps intentionally with
 * `detectAgentPlatforms()` in `detect.ts`. That function scans for harness
 * presence to display installed platforms to the user; these importers go
 * further by reading and parsing the harness config. They serve different
 * purposes and should not be deduplicated.
 */

import fs from "node:fs";
import path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * LLM/provider config extracted from an agent harness.
 * API key VALUES are never stored — only env var names.
 */
export interface HarnessLLMConfig {
  /** Human-readable source label, e.g. "Claude Code" */
  harnessName: string;
  /** Provider identifier, e.g. "anthropic", "openai" */
  provider?: string;
  /** Model identifier, e.g. "claude-sonnet-4-5" */
  model?: string;
  /** Base URL for the provider API */
  baseUrl?: string;
  /** Env var name (not value) that holds the API key */
  apiKeyEnvVar?: string;
  /** Additional detected models available from this harness */
  extraModels?: string[];
}

/**
 * A pluggable harness config importer.
 *
 * Importers are pure filesystem readers — no network calls, no side effects.
 */
export interface HarnessConfigImporter {
  /** Display name shown to user, e.g. "Claude Code" */
  harnessName: string;
  /**
   * Check if this harness is installed.
   * Must be fast: filesystem stat only, no network.
   */
  detect: () => boolean;
  /**
   * Read and parse harness config.
   * Returns `null` when config is absent or unreadable.
   */
  importConfig: () => HarnessLLMConfig | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

// ── Claude Code Importer ─────────────────────────────────────────────────────

/**
 * Imports LLM config from a Claude Code installation.
 *
 * Claude Code stores settings in `~/.claude/settings.json` or `~/.claude.json`.
 * The model field may appear at the root or under `env.ANTHROPIC_MODEL`.
 * The API key is always `ANTHROPIC_API_KEY`.
 */
const claudeCodeImporter: HarnessConfigImporter = {
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

// ── OpenCode Importer ────────────────────────────────────────────────────────

/**
 * Imports LLM config from an OpenCode installation.
 *
 * OpenCode stores config in `~/.config/opencode/config.json` or
 * `~/.opencode/config.json`. Its schema has a `providers` array and a
 * `model` field. API keys in providers appear as `$ENV_VAR_NAME` references.
 */
const openCodeImporter: HarnessConfigImporter = {
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

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Registry of all supported harness config importers.
 * To add a new harness: implement {@link HarnessConfigImporter} and append here.
 */
export const HARNESS_CONFIG_IMPORTERS: HarnessConfigImporter[] = [claudeCodeImporter, openCodeImporter];

/**
 * Run all importers whose `detect()` returns `true` and collect their configs.
 *
 * Pure function — filesystem reads only, no network, no side effects.
 * Individual importer failures are swallowed so one broken harness never
 * blocks the setup wizard.
 *
 * @returns List of detected harness configs (may be empty).
 */
export function detectHarnessConfigs(): HarnessLLMConfig[] {
  const results: HarnessLLMConfig[] = [];
  for (const importer of HARNESS_CONFIG_IMPORTERS) {
    try {
      if (!importer.detect()) continue;
      const config = importer.importConfig();
      if (config) results.push(config);
    } catch {
      // Never let one importer crash the whole detection
    }
  }
  return results;
}
