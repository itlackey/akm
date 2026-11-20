// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** First-run setup as a view model. Every state here is derived from what akm and the host report; none is stored. */

import type { Bundle } from "./types";

/** The official starter bundle as akm reports it: the address `bundle add` takes (a git source, so adding it downloads from GitHub) and its identity. */
export interface Starter {
  source: string;
  identity: string | null;
}

/** What `setup.detect` reports, and `setup.apply` returns once it has run. */
export interface Detected {
  stashDir: string;
  harnesses: Array<{ platform: string; path: string; modelWorkReadOnly: boolean; modelWorkNote: string }>;
  /** The platforms akm's config already enables. */
  enabled: string[];
  modelCalls: { platform: string | null; description: string };
  /** The connection that takes akm's model calls when no agent does; null when none is configured. */
  connection: string | null;
  /** Background learning: the host-wide switch, the platform improve runs on (null: a connection, or nowhere) and whether its task is scheduled. */
  learning: { on: boolean; harness: string | null; scheduled: boolean };
  /** Only from `setup.apply`: what the OS scheduler did not get (no host akm to write its entry). */
  warnings?: string[];
}

/** Background learning is switched on and has somewhere to run. `learning.on` alone is only the switch. */
export const learningRuns = (d: Detected) => d.learning.on && (d.learning.harness !== null || d.connection !== null);

export interface HostHarness {
  id: string;
  installed: boolean;
  runnable?: boolean;
  version?: string;
  /** OpenCode's major, from its `--version`: 1 and 2 take different plugins. */
  major?: number;
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
};

/** The harness's name for a person: OpenCode 2 installs as the same `opencode` program and is told apart by its major. */
export const harnessLabel = (harness: { id: string; major?: number }) =>
  harness.id === "opencode" && harness.major === 2 ? "OpenCode 2" : (harnessNames[harness.id] ?? harness.id);

/**
 * The one release channel for the host's CLI and plugins: the saved choice, else the channel akm reports the installed
 * CLI follows, else (no host CLI yet, so setup installs the release that matches this app) Desktop's own release stage.
 * Desktop never derives a channel from a host version.
 */
export const pluginChannel = (
  engine: string | undefined,
  saved?: "latest" | "next",
  reported?: "latest" | "next",
): "latest" | "next" => saved ?? reported ?? (engine && /^\d+\.\d+\.\d+-/.test(engine) ? "next" : "latest");

/** What the harness says about the akm plugin, in words. */
export function pluginLine(harness: HostHarness): string {
  if (!harness.installed) return "Harness not found";
  if (!harness.runnable) return "Harness could not start";
  const plugin = harness.plugin;
  if (!plugin) return "AKM plugin not checked";
  const version = plugin.version ? ` ${plugin.version}` : "";
  switch (plugin.state) {
    case "missing":
      return "AKM plugin not installed";
    case "installed":
      return `AKM plugin${version} installed`;
    case "disabled":
      return `AKM plugin${version} installed but turned off in the harness`;
    case "configured":
      return `AKM plugin ${plugin.spec ?? ""} configured (OpenCode installs it when it starts)`.replace("  ", " ");
    default:
      return "AKM plugin could not be verified";
  }
}

/**
 * What `akm upgrade --check` reported for a present plugin: nothing for a plugin that is not there, or when the host
 * CLI has not been checked or did not list it.
 */
export function pluginPlan<T extends { harness: string }>(
  harness: HostHarness,
  plugins: T[] | undefined,
): T | undefined {
  if (!["installed", "configured", "disabled"].includes(harness.plugin?.state ?? "")) return undefined;
  const name =
    harness.id === "claude"
      ? "claude-code"
      : harness.id === "opencode" && harness.major === 2
        ? "opencode-v2"
        : harness.id;
  return plugins?.find((plugin) => plugin.harness === name);
}

/** Whether akm's check for a plugin asks something of the person: an update to install, one deferred, or a failure. */
export const pluginNeedsUpdate = (plan: { outcome?: string } | undefined): boolean =>
  ["pending", "deferred", "failed"].includes(plan?.outcome ?? "");

/** Nothing is configured: no bundle. Home shows setup instead of health failures then. */
export const isUnconfigured = (listing: { bundles: unknown[] }) => listing.bundles.length === 0;

/** The starter is the bundle whose source has the starter's identity, whatever it is named. */
export const hasStarter = (bundles: Bundle[], starter: Starter) =>
  starter.identity !== null && bundles.some((bundle) => bundle.identity === starter.identity);

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
  plugin?: { text: string };
  /** The plugin cannot be installed until Bun is. */
  needsBun: boolean;
  /**
   * Whether akm can use this harness (it finds the program on its own PATH) and whether it is enabled in akm's config,
   * with akm's words for what its model calls could do there.
   */
  learning: { available: boolean; enabled: boolean; note: string; readOnly: boolean | null };
}

/**
 * One card per harness Desktop found. A harness that is not installed is not offered. `detected` is `setup.detect`:
 * the programs akm finds on its PATH and those its config enables.
 */
export function agentCards(host: HostSnapshot, detected: Detected): AgentCard[] {
  return host.harnesses
    .filter((harness) => harness.installed)
    .map((harness) => {
      const platform = harness.id;
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
        name: harnessLabel(harness),
        version: harness.version,
        state,
        ...(state === "connected"
          ? { plugin: { text: version ? `AKM plugin ${version}` : `AKM plugin ${harness.plugin?.spec ?? ""}`.trim() } }
          : {}),
        needsBun: ["claude", "codex"].includes(harness.id) && host.bun?.installed === false,
        learning: {
          available: seen !== undefined,
          enabled: detected.enabled.includes(platform),
          note: seen?.modelWorkNote ?? "",
          readOnly: seen?.modelWorkReadOnly ?? null,
        },
      };
    });
}

/** What the person typed or chose for background learning; `undefined` is untouched. */
export interface LearnInput {
  learn?: boolean;
  /** `internal` (akm itself) or the platform of an agent akm may use. */
  where?: string;
  endpoint: string;
  model: string;
  keyEnv: string;
}

export interface LearnPlan {
  on: boolean;
  where: string;
  /** Applying the plan would change what akm reports now. */
  changed: boolean;
  /** What `setup.apply` is sent for the connection and for learning; absent when there is nothing to write. */
  connection?: { endpoint: string; model: string; apiKeyEnv?: string };
  learning?: { on: boolean; harness?: string };
  /** Learning is wanted but nowhere to run: the one line that says why. */
  problem?: string;
}

/**
 * Background learning from `setup.detect` and the form. Learning is off unless the person turns it on, so whenever
 * setup applies anything it also writes the off state while learning is off; an on state is rewritten only when the
 * person changed it. `agents` are the platforms akm may use (enabled, or ticked now).
 */
export function learnPlan(detected: Detected, agents: string[], input: LearnInput): LearnPlan {
  const runs = learningRuns(detected);
  const on = input.learn ?? runs;
  // Where it runs now stands until the person picks: it may be an agent this page has no card for. While learning is
  // off nothing runs anywhere, so turning it on never lands on an agent the person has not picked.
  const wanted = input.where ?? (runs ? detected.learning.harness : null) ?? "internal";
  const where = wanted === "internal" || agents.includes(wanted) || input.where === undefined ? wanted : "internal";
  const endpoint = input.endpoint.trim(),
    model = input.model.trim(),
    keyEnv = input.keyEnv.trim();
  const connection = endpoint && model ? { endpoint, model, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) } : undefined;
  const problem =
    on && where === "internal" && detected.connection === null && !connection
      ? "akm itself needs a model connection: enter an endpoint and a model below, or choose an agent."
      : undefined;
  const target = on && where !== "internal" ? where : null;
  const changed =
    connection !== undefined || (!problem && (on !== runs || (on && target !== detected.learning.harness)));
  // An on state is sent whenever setup applies, so a save also gives it its scheduled improve task. Wanted on with
  // nowhere to run, learning is not turned on; while it is off, setup keeps writing off, so that an agent
  // enabled in the same apply does not take akm's model calls.
  const learning = problem
    ? runs
      ? undefined
      : { on: false }
    : !on
      ? { on: false }
      : { on: true, ...(target ? { harness: target } : {}) };
  return {
    on,
    where,
    changed,
    ...(connection ? { connection } : {}),
    ...(learning ? { learning } : {}),
    ...(problem ? { problem } : {}),
  };
}

/** What setup says after turning learning on or off: only what `setup.detect` reports afterwards. */
export function learnReceipt(next: Detected, wantedOn: boolean, agentName: string | undefined): string {
  if (!learningRuns(next)) {
    return wantedOn ? "Background learning stays off." : "Background learning is off.";
  }
  const where = next.learning.harness ? (agentName ?? next.learning.harness) : "akm itself";
  return `Background learning is on and runs on ${where}: ${next.modelCalls.description.replace(/\.$/, "")}.`;
}

/** The prompt to paste into a harness so that it searches akm, written for each harness's own surface (OpenCode 1 and 2 share one). */
export function checkPrompt(id: string, query: string): string {
  if (id === "claude") return `/akm-search ${query}`;
  if (id === "codex") return `Use the akm skill to search akm for "${query}".`;
  return `Use the akm_search tool to search akm for "${query}".`;
}

/** The searches recorded in a retrieval series (`activity.retrievalTrend`). */
export const searchCount = (series: { daily?: Array<{ searches: number }> } | null | undefined) =>
  (series?.daily ?? []).reduce((sum, day) => sum + day.searches, 0);
