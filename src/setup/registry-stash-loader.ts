// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Registry-driven stash discovery for the setup wizard.
 *
 * Fetches the list of available stashes from the official AKM registry,
 * using a cached result when available. Falls back to FALLBACK_STASHES
 * when the registry is unreachable or returns no results.
 *
 * Default-selected registry IDs are also bound to an authenticated install
 * target below so a configured registry cannot preselect a different source
 * merely by reusing a trusted display ID.
 */

import { hasRegistryUrlCredentials } from "../core/registry-url";
import { fetchRegistryJson } from "../registry/network";
import { parseRegistryRef } from "../registry/resolve";

// ── Default selections ──────────────────────────────────────────────────────

const AUTHENTICATED_DEFAULT_TARGETS: Readonly<Record<string, Pick<SetupBundleEntry, "installType" | "url">>> = {
  "itlackey/akm-stash": {
    installType: "git",
    url: "https://github.com/itlackey/akm-stash",
  },
};

// ── Types ───────────────────────────────────────────────────────────────────

/** A stash entry normalised for display in the setup wizard. */
export interface SetupBundleEntry {
  /** Unique registry identifier (matches `id` in the registry index). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Short description shown as a hint in the multiselect prompt. */
  description: string;
  /** Git clone URL or npm package reference. */
  url: string;
  /** Source kind persisted by setup; registry data cannot nominate raw Git. */
  installType: "git" | "npm";
  /** Origin of the entry: live registry data or the built-in fallback list. */
  source: "registry" | "fallback";
  /** Whether this stash is pre-checked on a fresh install. */
  defaultSelected: boolean;
}

// ── Fallback list ───────────────────────────────────────────────────────────

/**
 * Hardcoded stash list used when the registry is unreachable.
 * Mirrors the previous RECOMMENDED_GITHUB_REPOS constant.
 */
const FALLBACK_STASHES: SetupBundleEntry[] = [
  {
    id: "itlackey/akm-stash",
    name: "itlackey/akm-stash",
    description: "Official AKM onboarding bundle",
    url: "https://github.com/itlackey/akm-stash",
    installType: "git",
    source: "fallback",
    defaultSelected: true,
  },
  {
    id: "andrewyng/context-hub",
    name: "andrewyng/context-hub",
    description: "Optional community prompt and context bundle",
    url: "https://github.com/andrewyng/context-hub",
    installType: "git",
    source: "fallback",
    defaultSelected: false,
  },
];

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.
let loadSetupStashesOverride: typeof loadSetupStashesReal | undefined;

/** TEST-ONLY. Swap the implementation of `loadSetupStashes`; pass undefined to restore. */
export function _setLoadSetupStashesForTests(fake?: typeof loadSetupStashesReal): void {
  loadSetupStashesOverride = fake;
}

// ── Loader ──────────────────────────────────────────────────────────────────

/**
 * Fetch available stashes from the registry and map to SetupBundleEntry[].
 *
 * Falls back to FALLBACK_STASHES on network failure, parse error, or
 * empty response — setup never crashes due to a registry outage.
 *
 * @param registryUrl  URL of the registry index JSON.
 * @param timeoutMs    Fetch timeout in ms (default: 4000).
 */
export async function loadSetupStashes(registryUrl: string, timeoutMs = 4000): Promise<SetupBundleEntry[]> {
  if (hasRegistryUrlCredentials(registryUrl)) return FALLBACK_STASHES;
  if (loadSetupStashesOverride) return loadSetupStashesOverride(registryUrl, timeoutMs);
  return loadSetupStashesReal(registryUrl, timeoutMs);
}

async function loadSetupStashesReal(registryUrl: string, timeoutMs = 4000): Promise<SetupBundleEntry[]> {
  try {
    const raw = await fetchRegistryJson<{ stashes?: unknown[] }>(registryUrl, {
      headers: { Accept: "application/json" },
      timeoutMs,
      retries: 0,
    });
    if (!Array.isArray(raw?.stashes) || raw.stashes.length === 0) return FALLBACK_STASHES;

    const entries: SetupBundleEntry[] = raw.stashes.flatMap((item): SetupBundleEntry[] => {
      if (!item || typeof item !== "object") return [];
      const s = item as Record<string, unknown>;
      const id = typeof s.id === "string" ? s.id : "";
      const name = typeof s.name === "string" ? s.name : id;
      const description = typeof s.description === "string" ? s.description : "";
      const target = setupInstallTarget(s.source, s.ref);
      if (!id || !target) return [];
      return [
        {
          id,
          name,
          description,
          ...target,
          source: "registry",
          defaultSelected: authenticatedDefaultTarget(id, target),
        },
      ];
    });

    return entries.length > 0 ? entries : FALLBACK_STASHES;
  } catch {
    return FALLBACK_STASHES;
  }
}

function authenticatedDefaultTarget(id: string, target: Pick<SetupBundleEntry, "installType" | "url">): boolean {
  const expected = AUTHENTICATED_DEFAULT_TARGETS[id];
  return expected?.installType === target.installType && expected.url === target.url;
}

function setupInstallTarget(source: unknown, ref: unknown): Pick<SetupBundleEntry, "installType" | "url"> | undefined {
  if (typeof ref !== "string") return undefined;
  try {
    if (source === "npm") {
      const candidate = ref.startsWith("npm:") ? ref : `npm:${ref}`;
      const parsed = parseRegistryRef(candidate);
      return parsed.source === "npm" ? { installType: "npm", url: candidate } : undefined;
    }
    if (source === "github") {
      const candidate = ref.startsWith("github:") ? ref : `github:${ref}`;
      const parsed = parseRegistryRef(candidate);
      if (parsed.source !== "github") return undefined;
      return {
        installType: "git",
        url: `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      };
    }
  } catch {
    // Malformed registry install refs are omitted without breaking setup.
  }
  return undefined;
}
