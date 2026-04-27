/**
 * Setup-time agent CLI detection (v1 spec §12.3).
 *
 * Probes every known/configured agent profile by checking `which <bin>` on
 * PATH. We do **not** call `<bin> --version` — that would execute the
 * binary at setup time, which is unnecessarily side-effectful for
 * detection. The presence of the binary on PATH is sufficient signal; the
 * spawn wrapper handles failures at run-time.
 *
 * Tests inject a fake `whichFn` so detection branches can be exercised
 * without poking at the real PATH.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./config";
import { listResolvedAgentProfiles } from "./config";
import type { AgentProfile } from "./profiles";

/** Function signature for a binary lookup probe. */
export type WhichFn = (bin: string) => string | undefined;

/**
 * Default PATH lookup. Walks `process.env.PATH` and returns the first
 * existing executable file. Returns `undefined` when the bin is not on
 * PATH or the env is empty.
 *
 * `process.env.PATH` is split on the platform-correct delimiter; on
 * Windows the binary may have an executable extension, but for v1 we
 * keep this Unix-flavoured (Bun's primary target) and look for an exact
 * match.
 */
export function defaultWhich(bin: string, envSource: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!bin || bin.includes("/") || bin.includes("\\")) {
    // Absolute / relative paths: caller already specified location.
    try {
      return fs.statSync(bin).isFile() ? bin : undefined;
    } catch {
      return undefined;
    }
  }
  const pathVar = envSource.PATH ?? envSource.Path ?? envSource.path ?? "";
  if (!pathVar) return undefined;
  const sep = pathVar.includes(";") && !pathVar.includes(":") ? ";" : path.delimiter;
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* keep walking */
    }
  }
  return undefined;
}

/** Result of probing one profile during setup. */
export interface AgentDetectionResult {
  /** Profile name. */
  name: string;
  /** Bin checked on PATH. */
  bin: string;
  /** Resolved path on PATH, or `undefined` when not found. */
  resolvedPath?: string;
  /** True iff the binary was found. */
  available: boolean;
}

/**
 * Probe every resolvable agent profile (built-ins plus user overrides)
 * for an installed CLI.
 *
 * @param agent  Optional `agent` config block. When omitted we probe the
 *               built-ins.
 * @param whichFn  Binary lookup. Tests should inject a stub.
 */
export function detectAgentCliProfiles(agent?: AgentConfig, whichFn: WhichFn = defaultWhich): AgentDetectionResult[] {
  const profiles = listResolvedAgentProfiles(agent);
  return profiles.map((profile) => probeProfile(profile, whichFn));
}

function probeProfile(profile: AgentProfile, whichFn: WhichFn): AgentDetectionResult {
  const resolved = whichFn(profile.bin);
  return {
    name: profile.name,
    bin: profile.bin,
    available: Boolean(resolved),
    ...(resolved ? { resolvedPath: resolved } : {}),
  };
}

/**
 * Pick the default profile to persist after a setup-time detection run.
 *
 * Strategy:
 *   1. If the user already set `agent.default` and that profile is
 *      available, keep it (round-trip stability).
 *   2. Otherwise, pick the first available result in detection order.
 *   3. If nothing is available, return `undefined` and the caller skips
 *      writing `agent.default`.
 */
export function pickDefaultAgentProfile(results: AgentDetectionResult[], existingDefault?: string): string | undefined {
  if (existingDefault) {
    const match = results.find((r) => r.name === existingDefault && r.available);
    if (match) return match.name;
  }
  const first = results.find((r) => r.available);
  return first?.name;
}
