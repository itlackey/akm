// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup as a view model. Every state here is derived from what akm and the host report; none is stored. */

import type { Bundle } from "./types";

/** The official starter bundle: a git source, so adding it downloads from GitHub. */
export const STARTER = "github:itlackey/akm-stash";

/** What `setup.detect` reports, and `setup.apply` returns once it has run. */
export interface Detected {
  stashDir: string;
  harnesses: Array<{ platform: string; path: string; modelWorkNote: string }>;
  /** The platforms akm's config already enables. */
  enabled: string[];
  modelCalls: { platform: string | null; description: string };
}

export interface HostHarness {
  id: string;
  installed: boolean;
  runnable?: boolean;
  version?: string;
  plugin?: { state: string; version?: string; spec?: string; note?: string; detail?: string };
}
export interface HostSnapshot {
  cli: { installed: boolean; runnable?: boolean; version?: string; path?: string } | null;
  bun: { installed: boolean; installCommand: string } | null;
  harnesses: HostHarness[];
}

export const harnessNames: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  opencode2: "OpenCode 2",
};

/** Desktop is the release stage of the akm it embeds, so its plugins follow the same channel (see plugin-upgrade.ts). */
export const pluginChannel = (engine: string | undefined): "latest" | "next" =>
  engine && /^\d+\.\d+\.\d+-/.test(engine) ? "next" : "latest";

const majorMinor = (version: string | undefined) =>
  version
    ?.match(/^(\d+)\.(\d+)\./)
    ?.slice(1, 3)
    .join(".");

/**
 * Plugins share akm's major.minor and number their builds on their own, so a plugin matches this Desktop when its
 * major.minor is the engine's. Null when either is unknown, as for an OpenCode plugin before OpenCode has loaded it.
 */
export function pluginMatches(engine: string | undefined, plugin: string | undefined): boolean | null {
  const [a, b] = [majorMinor(engine), majorMinor(plugin)];
  return a && b ? a === b : null;
}

/** The name akm's own `harnesses` setting uses for a harness Desktop installs a plugin into. */
export const akmPlatform = (id: string) => (id === "opencode2" ? "opencode" : id);

/** Nothing is configured: no bundle and no working library. Home shows setup instead of health failures then. */
export const isUnconfigured = (listing: { bundles: unknown[]; workingStash: unknown | null }) =>
  listing.bundles.length === 0 && !listing.workingStash;

export const hasStarter = (bundles: Bundle[]) =>
  bundles.some((bundle) => /akm-stash/.test(`${bundle.name} ${bundle.source?.locator ?? ""}`));

export interface AgentCard {
  id: string;
  name: string;
  version?: string;
  /**
   * `ready`: the plugin can be installed. `disabled`: it is installed and turned off in the harness. `unverified`: the
   * harness could not say, so nothing is installed over it.
   */
  state: "stopped" | "unverified" | "disabled" | "ready" | "connected";
  /** The plugin as the harness reports it, for the card's version line. */
  plugin?: { text: string; mismatch: boolean };
  /** The plugin cannot be installed until Bun is. */
  needsBun: boolean;
  /**
   * Whether akm can use this harness (it finds the program on its own PATH), whether it is enabled in akm's config, and
   * whether akm's model calls (learning) run on it now, with akm's words for what those calls could do there.
   */
  learning: { available: boolean; enabled: boolean; active: boolean; note: string };
}

/**
 * One card per harness Desktop found. A harness that is not installed is not offered. `detected` is `setup.detect`:
 * the programs akm finds on its PATH, those its config enables, and the one its own model calls run on, if any.
 */
export function agentCards(host: HostSnapshot, engine: string | undefined, detected: Detected): AgentCard[] {
  return host.harnesses
    .filter((harness) => harness.installed)
    .map((harness) => {
      const platform = akmPlatform(harness.id);
      const seen = detected.harnesses.find((found) => found.platform === platform);
      const state: AgentCard["state"] = !harness.runnable
        ? "stopped"
        : ["installed", "configured"].includes(harness.plugin?.state ?? "")
          ? "connected"
          : harness.plugin?.state === "missing"
            ? "ready"
            : harness.plugin?.state === "disabled"
              ? "disabled"
              : "unverified";
      const version = harness.plugin?.version;
      return {
        id: harness.id,
        name: harnessNames[harness.id] ?? harness.id,
        version: harness.version,
        state,
        ...(state === "connected"
          ? {
              plugin: {
                text: version ? `AKM plugin ${version}` : `AKM plugin ${harness.plugin?.spec ?? ""}`.trim(),
                mismatch: pluginMatches(engine, version) === false,
              },
            }
          : {}),
        needsBun: ["claude", "codex"].includes(harness.id) && host.bun?.installed === false,
        learning: {
          available: seen !== undefined,
          enabled: detected.enabled.includes(platform),
          active: platform === detected.modelCalls.platform,
          note: seen?.modelWorkNote ?? "",
        },
      };
    });
}

/** The prompt to paste into a harness so that it searches akm, written for each harness's own surface. */
export function checkPrompt(id: string, query: string): string {
  if (id === "claude") return `/akm-search ${query}`;
  if (id === "codex") return `Use the akm skill to search akm for "${query}".`;
  return `Use the akm_search tool to search akm for "${query}".`;
}

/** The searches recorded in a retrieval series (`activity.retrievalTrend`). */
export const searchCount = (series: { daily?: Array<{ searches: number }> } | null | undefined) =>
  (series?.daily ?? []).reduce((sum, day) => sum + day.searches, 0);
