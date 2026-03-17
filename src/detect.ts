/**
 * Service detection utilities for the setup wizard.
 *
 * Pure detection functions with no user interaction — each returns
 * a result object describing what was found.
 */

import fs from "node:fs";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface OllamaDetectionResult {
  available: boolean;
  models: string[];
  endpoint: string;
}

export interface AgentPlatform {
  name: string;
  path: string;
}

export interface OpenVikingDetectionResult {
  available: boolean;
  url: string;
}

// ── Ollama Detection ────────────────────────────────────────────────────────

const OLLAMA_BASE = "http://localhost:11434";

/**
 * Detect if Ollama is running and list available models.
 *
 * Tries the HTTP API first (`/api/tags`), then falls back to `ollama list`
 * via subprocess. Returns available models sorted alphabetically.
 */
export async function detectOllama(): Promise<OllamaDetectionResult> {
  const result: OllamaDetectionResult = { available: false, models: [], endpoint: OLLAMA_BASE };

  // Try HTTP API first
  try {
    const response = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      if (Array.isArray(data.models)) {
        result.models = data.models
          .map((m) => (typeof m.name === "string" ? m.name.replace(/:latest$/, "") : ""))
          .filter(Boolean)
          .sort();
        result.available = true;
        return result;
      }
    }
  } catch {
    // HTTP failed — try CLI fallback
  }

  // CLI fallback
  try {
    const proc = Bun.spawn(["ollama", "list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode === 0 && text.trim()) {
      const lines = text.trim().split("\n").slice(1); // skip header
      result.models = lines
        .map((line) => {
          const name = line.split(/\s+/)[0]?.replace(/:latest$/, "");
          return name || "";
        })
        .filter(Boolean)
        .sort();
      result.available = true;
    }
  } catch {
    // Ollama not installed or not in PATH
  }

  return result;
}

// ── Agent Platform Detection ────────────────────────────────────────────────

const AGENT_PLATFORMS: Array<{ name: string; relPath: string }> = [
  { name: "Claude Code", relPath: ".claude" },
  { name: "OpenCode", relPath: ".config/opencode" },
  { name: "Continue", relPath: ".continue" },
  { name: "Codeium / Windsurf", relPath: ".codeium" },
  { name: "Cursor", relPath: ".cursor" },
  { name: "Codex CLI", relPath: ".codex" },
];

/**
 * Scan the user's home directory for known agent platform config directories.
 * Supports both HOME (Unix) and USERPROFILE (Windows).
 */
export function detectAgentPlatforms(): AgentPlatform[] {
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (!home) return [];

  return AGENT_PLATFORMS.filter((p) => {
    const fullPath = path.join(home, p.relPath);
    try {
      return fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  }).map((p) => ({
    name: p.name,
    path: path.join(home, p.relPath),
  }));
}

// ── OpenViking Detection ────────────────────────────────────────────────────

/**
 * Check if an OpenViking server is reachable at the given URL.
 * Uses the lightweight /api/v1/fs/stat endpoint (GET) rather than
 * the search endpoint which requires a running search index.
 */
export async function detectOpenViking(url: string): Promise<OpenVikingDetectionResult> {
  const normalized = url.replace(/\/+$/, "");
  try {
    // Any HTTP response (even non-2xx) from the API endpoint means the server is reachable.
    // Only network errors / timeouts indicate the server is truly unavailable.
    await fetch(`${normalized}/api/v1/fs/stat?uri=${encodeURIComponent("viking://")}`, {
      signal: AbortSignal.timeout(5000),
    });
    return { available: true, url: normalized };
  } catch {
    // stat endpoint unreachable — try root URL as fallback
    try {
      await fetch(normalized, { signal: AbortSignal.timeout(5000) });
      return { available: true, url: normalized };
    } catch {
      return { available: false, url: normalized };
    }
  }
}
