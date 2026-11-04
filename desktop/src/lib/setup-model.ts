// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup as a view model. Every state here is derived from what akm and the host report; none is stored. */

import type { Bundle } from "./types";

/** The official starter bundle: a git source, so adding it downloads from GitHub. */
export const STARTER = "github:itlackey/akm-stash";

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
  /** `ready`: the plugin can be installed. `unverified`: the harness could not say, so nothing is installed over it. */
  state: "stopped" | "unverified" | "ready" | "connected";
  /** The plugin as the harness reports it, for the card's version line. */
  plugin?: { text: string; mismatch: boolean };
  /** The plugin cannot be installed until Bun is. */
  needsBun: boolean;
  /** Whether akm may use this harness for learning, and whether the config already lets it. */
  learning: { available: boolean; enabled: boolean };
}

/** One card per harness Desktop found. A harness that is not installed is not offered. */
export function agentCards(
  host: HostSnapshot,
  engine: string | undefined,
  akmSees: string[],
  enabled: string[],
): AgentCard[] {
  return host.harnesses
    .filter((harness) => harness.installed)
    .map((harness) => {
      const platform = akmPlatform(harness.id);
      const state: AgentCard["state"] = !harness.runnable
        ? "stopped"
        : ["installed", "configured"].includes(harness.plugin?.state ?? "")
          ? "connected"
          : harness.plugin?.state === "missing"
            ? "ready"
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
        learning: { available: akmSees.includes(platform), enabled: enabled.includes(platform) },
      };
    });
}
