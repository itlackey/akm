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
 * Adding a new default-selected stash: append its registry ID to
 * DEFAULT_SELECTED_STASH_IDS below. No other change required.
 */

// ── Default selections ──────────────────────────────────────────────────────

/**
 * Registry stash IDs that are pre-selected by default during setup.
 * To add a new default stash: append its registry ID here.
 * IDs must match the `id` field in the official registry index.
 *
 * This is the single source of truth for which stashes are pre-checked
 * in the setup wizard. No other change is required to adjust defaults.
 */
export const DEFAULT_SELECTED_STASH_IDS: readonly string[] = ["itlackey/akm-stash"] as const;

// ── Types ───────────────────────────────────────────────────────────────────

/** A stash entry normalised for display in the setup wizard. */
export interface SetupStashEntry {
  /** Unique registry identifier (matches `id` in the registry index). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Short description shown as a hint in the multiselect prompt. */
  description: string;
  /** Git clone URL or npm package reference. */
  url: string;
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
const FALLBACK_STASHES: SetupStashEntry[] = [
  {
    id: "itlackey/akm-stash",
    name: "itlackey/akm-stash",
    description: "Official AKM onboarding stash",
    url: "https://github.com/itlackey/akm-stash",
    source: "fallback",
    defaultSelected: true,
  },
  {
    id: "andrewyng/context-hub",
    name: "andrewyng/context-hub",
    description: "Optional community prompt and context stash",
    url: "https://github.com/andrewyng/context-hub",
    source: "fallback",
    defaultSelected: false,
  },
];

// ── Loader ──────────────────────────────────────────────────────────────────

/**
 * Fetch available stashes from the registry and map to SetupStashEntry[].
 *
 * Falls back to FALLBACK_STASHES on network failure, parse error, or
 * empty response — setup never crashes due to a registry outage.
 *
 * @param registryUrl  URL of the registry index JSON.
 * @param timeoutMs    Fetch timeout in ms (default: 4000).
 */
export async function loadSetupStashes(registryUrl: string, timeoutMs = 4000): Promise<SetupStashEntry[]> {
  try {
    const response = await fetch(registryUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return FALLBACK_STASHES;

    const raw = (await response.json()) as { stashes?: unknown[] };
    if (!Array.isArray(raw.stashes) || raw.stashes.length === 0) return FALLBACK_STASHES;

    const entries: SetupStashEntry[] = raw.stashes.flatMap((item): SetupStashEntry[] => {
      if (!item || typeof item !== "object") return [];
      const s = item as Record<string, unknown>;
      const id = typeof s.id === "string" ? s.id : "";
      const name = typeof s.name === "string" ? s.name : id;
      const description = typeof s.description === "string" ? s.description : "";
      // Prefer github/git source URL built from the ref; fall back to homepage
      const url =
        (s.source === "github" || s.source === "git") && typeof s.ref === "string"
          ? `https://github.com/${s.ref.replace(/^github:/, "")}`
          : typeof s.homepage === "string"
            ? s.homepage
            : "";
      if (!id || !url) return [];
      return [
        {
          id,
          name,
          description,
          url,
          source: "registry",
          defaultSelected: DEFAULT_SELECTED_STASH_IDS.includes(id),
        },
      ];
    });

    return entries.length > 0 ? entries : FALLBACK_STASHES;
  } catch {
    return FALLBACK_STASHES;
  }
}
