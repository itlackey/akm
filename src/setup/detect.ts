// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Service detection utilities for the setup wizard.
 *
 * Pure detection functions with no user interaction — each returns
 * a result object describing what was found.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWhich, type WhichFn } from "../integrations/agent/detect";
import { detectHarnessConfigs, type HarnessLLMConfig } from "./harness-config-import";

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

// ── LM Studio Detection ────────────────────────────────────────────────────

export interface LMStudioDetectionResult {
  available: boolean;
  models: string[];
  endpoint: string;
}

const LMSTUDIO_BASE = "http://localhost:1234";

/**
 * Detect if LM Studio is running and list available models.
 * Probes the OpenAI-compatible /v1/models endpoint.
 */
export async function detectLMStudio(): Promise<LMStudioDetectionResult> {
  const result: LMStudioDetectionResult = { available: false, models: [], endpoint: LMSTUDIO_BASE };
  try {
    const response = await fetch(`${LMSTUDIO_BASE}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      if (Array.isArray(data.data)) {
        result.models = data.data
          .map((m) => (typeof m.id === "string" ? m.id : ""))
          .filter(Boolean)
          .sort();
        result.available = true;
      }
    }
  } catch {
    // LM Studio not running or not accessible
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

// ── Provider Env-Var Scan ────────────────────────────────────────────────────

/**
 * An inferred provider derived from an environment variable NAME.
 *
 * SAFETY INVARIANT: This type intentionally has no field for an API key
 * value. Only the env var NAME is ever recorded. Values are never read,
 * stored, logged, or emitted.
 */
export interface InferredProviderEnv {
  /** Provider identifier, e.g. "anthropic", "openai", "ollama". */
  provider: string;
  /**
   * Env var NAME that was present (never its value), e.g. "ANTHROPIC_API_KEY".
   */
  envVar: string;
  /** What the env var configures: an API key or an endpoint/base URL. */
  kind: "apiKey" | "endpoint";
}

/**
 * Map of env var NAME → { provider, kind }. The key NAMES are the only thing
 * this module ever inspects from `process.env`; values are never touched.
 */
const PROVIDER_ENV_VARS: Array<{ name: string; provider: string; kind: "apiKey" | "endpoint" }> = [
  { name: "ANTHROPIC_API_KEY", provider: "anthropic", kind: "apiKey" },
  { name: "OPENAI_API_KEY", provider: "openai", kind: "apiKey" },
  { name: "GEMINI_API_KEY", provider: "gemini", kind: "apiKey" },
  { name: "GOOGLE_API_KEY", provider: "gemini", kind: "apiKey" },
  { name: "GROQ_API_KEY", provider: "groq", kind: "apiKey" },
  { name: "OLLAMA_HOST", provider: "ollama", kind: "endpoint" },
  { name: "OLLAMA_BASE_URL", provider: "ollama", kind: "endpoint" },
  { name: "LM_STUDIO_BASE_URL", provider: "lmstudio", kind: "endpoint" },
  { name: "LM_STUDIO_API_BASE", provider: "lmstudio", kind: "endpoint" },
  { name: "LMSTUDIO_BASE_URL", provider: "lmstudio", kind: "endpoint" },
  { name: "LMSTUDIO_API_BASE", provider: "lmstudio", kind: "endpoint" },
  { name: "AKM_LLM_API_KEY", provider: "akm-llm", kind: "apiKey" },
  { name: "AKM_LLM_ENDPOINT", provider: "akm-llm", kind: "endpoint" },
  { name: "AKM_LLM_BASE_URL", provider: "akm-llm", kind: "endpoint" },
];

/**
 * Scan `process.env` for the presence of known provider configuration env var
 * NAMES and return inferred providers.
 *
 * Pure function — no network, no filesystem. It reads only whether each known
 * key is *defined and non-empty*; it never reads, returns, or logs the value.
 *
 * @param envSource  Env to inspect. Defaults to `process.env`. Tests inject a
 *                   fake env so a real API key is never required.
 * @returns Inferred providers, each carrying the env var NAME only.
 */
export function scanProviderEnvVars(envSource: NodeJS.ProcessEnv = process.env): InferredProviderEnv[] {
  const results: InferredProviderEnv[] = [];
  for (const entry of PROVIDER_ENV_VARS) {
    const value = envSource[entry.name];
    const present = typeof value === "string" && value.trim().length > 0;
    if (!present) continue;
    results.push({ provider: entry.provider, envVar: entry.name, kind: entry.kind });
  }
  return results;
}

// ── Generic Local Endpoint Probe ─────────────────────────────────────────────

export interface LocalServerResult {
  /** Base URL probed, e.g. "http://localhost:8080". */
  baseUrl: string;
  /** True iff the OpenAI-compatible /v1/models endpoint responded. */
  available: boolean;
  /** Models advertised by the endpoint (may be empty). */
  models: string[];
  /** Suggested default model picked by {@link pickDefaultModel}. */
  defaultModel?: string;
  /** Human-readable label, e.g. "Ollama", "LM Studio", "Local (8080)". */
  label: string;
}

/** Default endpoints probed in addition to any harness-config base URLs. */
const DEFAULT_LOCAL_ENDPOINTS: Array<{ baseUrl: string; label: string }> = [
  { baseUrl: "http://localhost:11434", label: "Ollama" },
  { baseUrl: "http://localhost:1234", label: "LM Studio" },
  { baseUrl: "http://localhost:8080", label: "Local (8080)" },
];

/**
 * Pick a sensible default model from a list via a name heuristic.
 *
 * Preference order: an explicit "instruct" variant, then the longest name
 * (a rough proxy for the larger / more-capable variant), then the first.
 * Returns `undefined` for an empty list.
 */
export function pickDefaultModel(models: string[]): string | undefined {
  const cleaned = models.filter((m) => typeof m === "string" && m.trim().length > 0);
  if (cleaned.length === 0) return undefined;
  const instruct = cleaned.filter((m) => /instruct/i.test(m));
  const pool = instruct.length > 0 ? instruct : cleaned;
  // Prefer the longest name as a proxy for the larger/most-specific variant,
  // breaking ties by sort order for determinism.
  return [...pool].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

/**
 * Probe a single OpenAI-compatible `/v1/models` endpoint.
 *
 * Tolerant of failure: any network/timeout/parse error yields an
 * `available: false` result rather than throwing.
 */
export async function probeLocalEndpoint(baseUrl: string, label: string, timeoutMs = 2000): Promise<LocalServerResult> {
  const result: LocalServerResult = { baseUrl, label, available: false, models: [] };
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      if (Array.isArray(data.data)) {
        result.models = data.data
          .map((m) => (typeof m.id === "string" ? m.id : ""))
          .filter(Boolean)
          .sort();
        result.available = true;
        result.defaultModel = pickDefaultModel(result.models);
      }
    }
  } catch {
    // Endpoint down/unreachable — leave available=false.
  }
  return result;
}

/**
 * Probe the default local endpoints (Ollama 11434, LM Studio 1234, generic
 * 8080) plus any base URLs found in imported harness configs.
 *
 * Never throws: every endpoint being down yields a list of unavailable
 * results, not an error.
 *
 * @param harnessBaseUrls  Extra base URLs to probe (e.g. from harness configs).
 */
export async function detectLocalServers(harnessBaseUrls: string[] = []): Promise<LocalServerResult[]> {
  const endpoints: Array<{ baseUrl: string; label: string }> = [...DEFAULT_LOCAL_ENDPOINTS];
  for (const raw of harnessBaseUrls) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    // Strip a trailing /v1 (and trailing slash) so we probe consistently.
    const baseUrl = raw.replace(/\/$/, "").replace(/\/v1$/, "");
    if (!endpoints.some((e) => e.baseUrl === baseUrl)) {
      endpoints.push({ baseUrl, label: `Harness (${baseUrl})` });
    }
  }
  return Promise.all(endpoints.map((e) => probeLocalEndpoint(e.baseUrl, e.label)));
}

// ── Stash Directory Detection ────────────────────────────────────────────────

export interface StashDirSuggestion {
  /** Absolute path suggested for the stash directory. */
  path: string;
  /** Why it was suggested. */
  reason: string;
  /** Rank — lower is higher priority. */
  rank: number;
}

/**
 * Suggest stash directories, ranked (lower rank = higher priority).
 *
 * Sources, in priority order:
 *   1. An existing config `stashDir` (always rank 0 — no-op / keep current).
 *   2. A `akm/` or `agent-stash/` directory in the CWD git repo.
 *   3. `~/akm` then `~/.akm` when they already exist.
 *
 * Pure function — filesystem reads only, no network. Tests inject `cwd`/`home`.
 */
export function detectStashDir(opts?: {
  existingStashDir?: string;
  cwd?: string;
  home?: string;
}): StashDirSuggestion[] {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? os.homedir();
  const suggestions: StashDirSuggestion[] = [];
  const seen = new Set<string>();
  const push = (p: string, reason: string, rank: number): void => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    suggestions.push({ path: abs, reason, rank });
  };

  if (opts?.existingStashDir?.trim()) {
    push(opts.existingStashDir, "existing config stashDir", 0);
  }

  // CWD git repo containing akm/ or agent-stash/
  const repoRoot = findGitRepoRoot(cwd);
  if (repoRoot) {
    for (const dirName of ["akm", "agent-stash"]) {
      const candidate = path.join(repoRoot, dirName);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          push(candidate, `git repo contains ${dirName}/`, 1);
        }
      } catch {
        // not present
      }
    }
  }

  // ~/akm then ~/.akm when they exist
  if (home) {
    for (const dirName of ["akm", ".akm"]) {
      const candidate = path.join(home, dirName);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          push(candidate, `${dirName} exists in home`, 2);
        }
      } catch {
        // not present
      }
    }
  }

  return suggestions.sort((a, b) => a.rank - b.rank);
}

/** Walk up from `start` looking for a directory containing `.git`. */
function findGitRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ── Aggregate Environment Detection ──────────────────────────────────────────

export type DetectedHarness = "opencode-sdk" | "opencode" | "claude" | "none";

export interface DetectedEnvironment {
  /** Best available agent harness, in priority order. */
  harness: DetectedHarness;
  /** Inferred providers from env var NAMES (never values). */
  providers: InferredProviderEnv[];
  /** Imported harness LLM configs (env-var names only — never key values). */
  harnessConfigs: HarnessLLMConfig[];
  /** Local OpenAI-compatible servers that responded. */
  localServers: LocalServerResult[];
  /** Ranked stash directory suggestions. */
  stashSuggestions: StashDirSuggestion[];
  /** Installed agent platform config directories. */
  agentPlatforms: AgentPlatform[];
}

/**
 * Detect the best agent harness in priority order:
 *   1. OpenCode SDK resolvable via `import('@opencode-ai/sdk')`.
 *   2. `opencode` binary on PATH.
 *   3. `claude` binary on PATH.
 *   4. none.
 *
 * Pure aside from the dynamic import resolution (which performs no network).
 */
export async function detectHarness(whichFn: WhichFn = defaultWhich): Promise<DetectedHarness> {
  try {
    await import("@opencode-ai/sdk");
    return "opencode-sdk";
  } catch {
    // SDK not installed — fall through to bin probes.
  }
  if (whichFn("opencode")) return "opencode";
  if (whichFn("claude")) return "claude";
  return "none";
}

/**
 * Run the full environment-detection pipeline once and return a single typed
 * result. Orchestrates env-var scan, harness config import, harness selection,
 * local-server probes, and stash-dir suggestions.
 *
 * SAFETY: No API key VALUE is ever read, stored, logged, or returned — only
 * env var NAMES. Tolerant of every detector failing.
 *
 * @param opts.existingStashDir  Current config stashDir (no-op suggestion).
 * @param opts.envSource  Env to scan. Defaults to `process.env`.
 * @param opts.whichFn  Binary lookup. Tests inject a stub.
 */
export async function detectEnvironment(opts?: {
  existingStashDir?: string;
  envSource?: NodeJS.ProcessEnv;
  whichFn?: WhichFn;
  cwd?: string;
  home?: string;
}): Promise<DetectedEnvironment> {
  const envSource = opts?.envSource ?? process.env;
  const whichFn = opts?.whichFn ?? defaultWhich;

  let harnessConfigs: HarnessLLMConfig[] = [];
  try {
    harnessConfigs = detectHarnessConfigs();
  } catch {
    harnessConfigs = [];
  }

  const harnessBaseUrls = harnessConfigs.map((c) => c.baseUrl).filter((u): u is string => typeof u === "string");

  const [harness, localServers] = await Promise.all([
    detectHarness(whichFn),
    detectLocalServers(harnessBaseUrls).catch(() => [] as LocalServerResult[]),
  ]);

  let agentPlatforms: AgentPlatform[] = [];
  try {
    agentPlatforms = detectAgentPlatforms();
  } catch {
    agentPlatforms = [];
  }

  return {
    harness,
    providers: scanProviderEnvVars(envSource),
    harnessConfigs,
    localServers,
    stashSuggestions: detectStashDir({
      existingStashDir: opts?.existingStashDir,
      cwd: opts?.cwd,
      home: opts?.home,
    }),
    agentPlatforms,
  };
}

/**
 * Render a compact, human-readable "Detected environment" summary block.
 * Contains env var NAMES only — never any value.
 */
export function renderDetectionSummary(env: DetectedEnvironment): string {
  const lines: string[] = ["Detected environment:"];
  lines.push(`  Harness:        ${env.harness}`);

  const liveServers = env.localServers.filter((s) => s.available);
  if (liveServers.length > 0) {
    lines.push(
      `  Local servers:  ${liveServers
        .map((s) => `${s.label}${s.defaultModel ? ` (${s.defaultModel})` : ""}`)
        .join(", ")}`,
    );
  } else {
    lines.push("  Local servers:  none reachable");
  }

  if (env.providers.length > 0) {
    // NAMES only — never values.
    lines.push(`  Provider keys:  ${env.providers.map((p) => `${p.provider}:${p.envVar}`).join(", ")}`);
  } else {
    lines.push("  Provider keys:  none in environment");
  }

  const topStash = env.stashSuggestions[0];
  if (topStash) {
    lines.push(`  Stash suggest:  ${topStash.path} (${topStash.reason})`);
  }

  return lines.join("\n");
}
