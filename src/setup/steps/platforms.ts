// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard steps for agent platforms and agent-CLI selection: detect
 * agent platform config dirs as stash sources, and pick a default agent CLI.
 */

import * as p from "../../cli/clack";
import type { AkmConfig, SourceConfigEntry } from "../../core/config/config";
import { type AgentDetectionResult, detectAgentCliProfiles, pickDefaultAgentProfile } from "../../integrations/agent";
import { detectAgentPlatforms } from "../detect";
import { type AgentEngineSelection, readAgentEngineSelection } from "../engine-config";
import { prompt } from "../prompt";
import type { SetupDraftConfig } from "../steps";

// The just-computed source list is threaded in as the draft's scratch `sources`.
export async function stepAgentPlatforms(current: SetupDraftConfig): Promise<SourceConfigEntry[]> {
  const platforms = detectAgentPlatforms();

  if (platforms.length === 0) {
    p.log.info("No agent platform configurations detected.");
    return [];
  }

  const existingPaths = new Set((current.sources ?? []).map((s) => s.path));

  // Filter out platforms already configured
  const newPlatforms = platforms.filter((pl) => !existingPaths.has(pl.path));

  if (newPlatforms.length === 0) {
    p.log.info(`Detected ${platforms.length} agent platform(s), all already configured as stash sources.`);
    return [];
  }

  const selected = await prompt(() =>
    p.multiselect({
      message: "Found agent platform configurations. Add as stash sources?",
      options: newPlatforms.map((pl) => ({
        value: pl.path,
        label: pl.name,
        hint: pl.path,
      })),
      required: false,
    }),
  );

  const entries: SourceConfigEntry[] = [];
  for (const selectedPath of selected) {
    const platform = newPlatforms.find((pl) => pl.path === selectedPath);
    if (platform) {
      entries.push({
        type: "filesystem",
        path: platform.path,
        name: platform.name.toLowerCase().replace(/\s+/g, "-"),
      });
    }
  }
  return entries;
}

/**
 * Print a feature capability summary after both connection steps are complete.
 */
export function printCapabilitySummary(smallModelSkipped: boolean, agentConfigured: boolean): void {
  const lines: string[] = ["Setup complete. Here's what's enabled:", ""];
  lines.push("  ✓ akm search, akm curate, akm show — always available");

  if (!smallModelSkipped) {
    lines.push("  ✓ akm index, akm distill, akm remember — small model configured");
  } else {
    lines.push("  ✗ akm index, akm distill, akm remember — run `akm setup` to enable");
  }

  if (agentConfigured) {
    lines.push("  ✓ akm propose, akm improve, akm tasks — agent configured");
  } else {
    lines.push("  ✗ akm propose, akm improve, akm tasks — run `akm setup` to enable");
  }

  p.note(lines.join("\n"), "Feature Summary");
}

/**
 * Result of the agent CLI detection step. The wizard surfaces this to the
 * caller so the consolidated config write at the end of setup can persist
 * the new `agent` block.
 *
 * @internal Exported for testing only.
 */
export interface AgentSetupResult {
  /** Updated agent config block, or `undefined` if the user has nothing installed and no existing block. */
  agent?: AgentEngineSelection;
  /** Per-profile detection results, available to the UI for display. */
  detections: AgentDetectionResult[];
}

export async function stepAgentSelection(
  current: AkmConfig,
  detections: AgentDetectionResult[],
): Promise<AgentEngineSelection | undefined> {
  const currentAgentBlock = readAgentEngineSelection(current);
  const available = detections.filter((d) => d.available);
  if (available.length === 0) {
    return currentAgentBlock;
  }

  const initialValue = pickDefaultAgentProfile(detections, currentAgentBlock?.default) ?? available[0]?.name;
  const selectedDefault = await prompt(() =>
    p.select({
      message: "Which detected agent CLI should be the default?",
      options: [
        ...available.map((d) => ({
          value: d.name,
          label: d.name,
          hint: d.resolvedPath ?? d.bin,
        })),
        { value: "disabled", label: "Disabled", hint: "do not configure a default agent CLI" },
      ],
      initialValue,
    }),
  );

  if (selectedDefault === "disabled") {
    if (!currentAgentBlock?.engines) {
      return undefined;
    }
    return {
      ...(currentAgentBlock ?? {}),
      default: undefined,
    };
  }

  return {
    ...(currentAgentBlock ?? {}),
    default: selectedDefault,
  };
}

/**
 * Detect installed agent CLIs and produce an updated `agent` config block
 * with a sensible `default` (the first detected profile that the user has
 * not already overridden).
 *
 * Pure-ish: file system / PATH probes are routed through `detectFn` so
 * tests can drive the branches without touching the real PATH.
 *
 * @internal Exported for testing only.
 */
export function stepAgentCliDetection(
  current: AkmConfig,
  detectFn: (config?: AkmConfig) => AgentDetectionResult[] = detectAgentCliProfiles,
): AgentSetupResult {
  const detections = detectFn(current);
  const currentAgentBlock = readAgentEngineSelection(current);
  const defaultName = pickDefaultAgentProfile(detections, currentAgentBlock?.default);

  // No installed agents found and no existing config → leave block absent.
  if (!defaultName && !currentAgentBlock) {
    return { detections };
  }

  const agent: AgentEngineSelection = {
    ...(currentAgentBlock ?? {}),
    ...(defaultName ? { default: defaultName } : {}),
  };
  return { agent, detections };
}
