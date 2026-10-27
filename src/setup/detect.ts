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
import type { HarnessId } from "../core/config/config";
import { defaultWhich, detectAgentCliProfiles, type WhichFn } from "../integrations/agent/detect";
import { HARNESS_CONFIG_PLATFORMS, SESSION_LOG_HARNESSES } from "../integrations/harnesses";
import { listEndpointModels } from "../llm/model-list";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentPlatform {
  name: string;
  path: string;
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.

interface DetectOverridesForTests {
  detectAgentPlatforms?: typeof detectAgentPlatforms;
}

let detectOverrides: DetectOverridesForTests | undefined;

/** TEST-ONLY. Swap the network/host probes; pass undefined to restore. */
export function _setDetectForTests(fakes?: DetectOverridesForTests): void {
  detectOverrides = fakes;
}

// ── Agent Platform Detection ────────────────────────────────────────────────

/**
 * Setup stash-source candidates, derived from the unified harness registry
 * (#567).
 *
 * BEHAVIOUR FIX: the old hardcoded list named 6 harnesses (Claude Code,
 * OpenCode, Continue, Codeium/Windsurf, Cursor, Codex CLI) but only the first
 * two have a session-log provider. Selecting any of the other four added a
 * filesystem stash source that was never indexed/extracted — a silent no-op
 * "detection trap" (sessions never reached the improve pipeline).
 *
 * The registry is now the single source of which harnesses are real stash
 * sources: a candidate must (a) register a `sessionLogProvider` AND
 * (b) declare a `setupDetectionDir`. `SESSION_LOG_HARNESSES` already filters by
 * (a), so dropping the four dead options is automatic — they aren't even in the
 * registry. Adding a new session-log harness with a detection dir makes it
 * appear here with no edit to this file.
 */
const AGENT_PLATFORMS: Array<{ name: string; relPath: string }> = SESSION_LOG_HARNESSES.filter(
  (h) => h.setupDetectionDir,
).map((h) => ({ name: h.displayName, relPath: h.setupDetectionDir as string }));

/**
 * Scan the user's home directory for known agent platform config directories.
 * Supports both HOME (Unix) and USERPROFILE (Windows).
 */
export function detectAgentPlatforms(): AgentPlatform[] {
  if (detectOverrides?.detectAgentPlatforms) return detectOverrides.detectAgentPlatforms();
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

// ── Generic Local Endpoint Probe ─────────────────────────────────────────────

export interface LocalServerResult {
  /** Base URL probed, e.g. "http://localhost:8080". */
  baseUrl: string;
  /** True iff the OpenAI-compatible /v1/models endpoint responded. */
  available: boolean;
  /** Models advertised by the endpoint (may be empty). */
  models: string[];
  /** Human-readable label, e.g. "Ollama", "LM Studio", "Local (8080)". */
  label: string;
}

/** Local servers that usually speak the OpenAI-compatible API. */
const DEFAULT_LOCAL_ENDPOINTS: Array<{ baseUrl: string; label: string }> = [
  { baseUrl: "http://localhost:11434", label: "Ollama" },
  { baseUrl: "http://localhost:1234", label: "LM Studio" },
  { baseUrl: "http://localhost:8080", label: "Local (8080)" },
];

/**
 * Probe a single OpenAI-compatible `/v1/models` endpoint.
 *
 * Tolerant of failure: any network/timeout/parse error yields an
 * `available: false` result rather than throwing.
 */
export async function probeLocalEndpoint(baseUrl: string, label: string, timeoutMs = 2000): Promise<LocalServerResult> {
  const listed = await listEndpointModels({ endpoint: `${baseUrl.replace(/\/$/, "")}/v1` }, timeoutMs);
  return listed.ok
    ? { baseUrl, label, available: true, models: [...listed.models].sort() }
    : { baseUrl, label, available: false, models: [] };
}

/**
 * Probe the default local endpoints (Ollama 11434, LM Studio 1234, generic 8080).
 *
 * Never throws: every endpoint being down yields a list of unavailable
 * results, not an error.
 */
export async function detectLocalServers(): Promise<LocalServerResult[]> {
  return Promise.all(DEFAULT_LOCAL_ENDPOINTS.map((e) => probeLocalEndpoint(e.baseUrl, e.label)));
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

// ── Harness Detection ────────────────────────────────────────────────────────

/** An agent program akm can run as a harness, found on PATH. */
export interface InstalledHarness {
  platform: HarnessId;
  bin: string;
  /** Where the binary was found. */
  path: string;
}

/**
 * The agent programs on PATH that can be enabled as a harness, in registry
 * order. A harness is installed when its binary is found; OpenCode is detected
 * like any other.
 */
export function detectInstalledHarnesses(whichFn: WhichFn = defaultWhich): InstalledHarness[] {
  const enableable = new Set<string>(HARNESS_CONFIG_PLATFORMS);
  return detectAgentCliProfiles(undefined, whichFn).flatMap((found) =>
    found.available && found.resolvedPath && enableable.has(found.name)
      ? [{ platform: found.name as HarnessId, bin: found.bin, path: found.resolvedPath }]
      : [],
  );
}

// ── Aggregate Environment Detection ──────────────────────────────────────────

export interface DetectedEnvironment {
  /** Agent programs on PATH that can be enabled as harnesses, in registry order. */
  harnesses: InstalledHarness[];
  /** Local OpenAI-compatible servers that responded. */
  localServers: LocalServerResult[];
  /** Ranked stash directory suggestions. */
  stashSuggestions: StashDirSuggestion[];
  /** Installed agent platform config directories. */
  agentPlatforms: AgentPlatform[];
}

/**
 * Run the full environment-detection pipeline once and return a single typed
 * result. Orchestrates harness detection, local-server probes, and stash-dir
 * suggestions. Tolerant of every detector failing.
 *
 * @param opts.existingStashDir  Current config stashDir (no-op suggestion).
 * @param opts.whichFn  Binary lookup. Tests inject a stub.
 * @param opts.probe  Contact the local servers. False for an offline run.
 */
export async function detectEnvironment(opts?: {
  existingStashDir?: string;
  whichFn?: WhichFn;
  cwd?: string;
  home?: string;
  probe?: boolean;
}): Promise<DetectedEnvironment> {
  const whichFn = opts?.whichFn ?? defaultWhich;

  const localServers = opts?.probe === false ? [] : await detectLocalServers().catch(() => [] as LocalServerResult[]);

  let agentPlatforms: AgentPlatform[] = [];
  try {
    agentPlatforms = detectAgentPlatforms();
  } catch {
    agentPlatforms = [];
  }

  return {
    harnesses: detectInstalledHarnesses(whichFn),
    localServers,
    stashSuggestions: detectStashDir({
      existingStashDir: opts?.existingStashDir,
      cwd: opts?.cwd,
      home: opts?.home,
    }),
    agentPlatforms,
  };
}

/** Render a compact, human-readable "Detected environment" summary block. */
export function renderDetectionSummary(env: DetectedEnvironment): string {
  const lines: string[] = ["Detected environment:"];
  lines.push(
    `  Harnesses:      ${env.harnesses.length > 0 ? env.harnesses.map((h) => h.platform).join(", ") : "none on PATH"}`,
  );

  const liveServers = env.localServers.filter((s) => s.available);
  if (liveServers.length > 0) {
    lines.push(`  Local servers:  ${liveServers.map((s) => s.label).join(", ")}`);
  } else {
    lines.push("  Local servers:  none reachable");
  }

  const topStash = env.stashSuggestions[0];
  if (topStash) {
    lines.push(`  Stash suggest:  ${topStash.path} (${topStash.reason})`);
  }

  return lines.join("\n");
}
