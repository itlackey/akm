// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup steps 1 and 2: which agent programs to enable as harnesses, which of
 * them agent work runs on, and whether akm's own model calls (improve, judging,
 * extraction) may run through it too.
 */

import * as p from "../../cli/clack";
import { type AkmConfig, defaultConnection, defaultHarness } from "../../core/config/config";
import { warn } from "../../core/warn";
import { getHarness } from "../../integrations/harnesses";
import type { InstalledHarness } from "../detect";
import type { EngineFlags } from "../engine-flags";
import type { HarnessAnswer } from "../engine-plan";
import { prompt } from "../prompt";
import { runsReadOnly } from "../summary";

export interface HarnessStepResult {
  /** Absent: the harnesses stay as they are. */
  answer?: HarnessAnswer;
  /** Whether model calls need no connection because the harness takes them. */
  modelCallsOnHarness: boolean;
}

export interface HarnessStepInput {
  current: AkmConfig;
  installed: readonly InstalledHarness[];
  flags: EngineFlags;
  interactive: boolean;
}

function readOnlyNote(platform: string): string {
  return runsReadOnly(platform) ? "model calls run read-only" : "model calls cannot be restricted to read-only";
}

function configuredPlatforms(current: AkmConfig): string[] {
  return [...new Set(Object.entries(current.harnesses ?? {}).map(([name, harness]) => harness.platform ?? name))];
}

/** The platform agent work runs on in the config, if any. */
function currentDefaultPlatform(current: AkmConfig): string | undefined {
  const found = defaultHarness(current);
  return found ? (found.harness.platform ?? found.name) : undefined;
}

export async function stepHarnesses(input: HarnessStepInput): Promise<HarnessStepResult> {
  const { current, installed, flags } = input;
  const configured = configuredPlatforms(current);
  const installedPlatforms: string[] = installed.map((harness) => harness.platform);

  let answer: HarnessAnswer | undefined;
  if (flags.harness) {
    for (const platform of flags.harness) {
      if (!installedPlatforms.includes(platform)) {
        warn(`[akm setup] ${platform} was not found on PATH; enabling it anyway.`);
      }
    }
    answer = { platforms: [...new Set([...configured, ...flags.harness])], default: flags.harness[0] };
  } else if (!input.interactive) {
    if (configured.length === 0 && installedPlatforms.length > 0) {
      answer = { platforms: installedPlatforms, default: installedPlatforms[0] };
    }
  } else {
    answer = await askHarnesses(current, installed, configured);
  }
  const result = (modelCallsOnHarness: boolean): HarnessStepResult => ({
    ...(answer ? { answer } : {}),
    modelCallsOnHarness,
  });

  // Model calls can go to a harness only when one is enabled and no connection exists or is being added.
  const defaultPlatform = answer ? answer.default : currentDefaultPlatform(current);
  if (defaultPlatform === undefined || defaultConnection(current) !== undefined || flags.endpoint !== undefined) {
    return result(false);
  }
  if (!input.interactive) return result(runsReadOnly(defaultPlatform));
  const yes = await prompt(() =>
    p.confirm({
      message: `Use ${defaultPlatform} for akm's own model calls too (improve, judging, extraction)? ${readOnlyNote(defaultPlatform)}.`,
      initialValue: true,
    }),
  );
  return result(yes);
}

async function askHarnesses(
  current: AkmConfig,
  installed: readonly InstalledHarness[],
  configured: readonly string[],
): Promise<HarnessAnswer | undefined> {
  const installedPlatforms: string[] = installed.map((harness) => harness.platform);
  const candidates = [...new Set([...installedPlatforms, ...configured])];
  if (candidates.length === 0) {
    p.log.info(
      "No agent programs found on PATH. Agent work runs on akm's own runtime over a connection (set one up next).",
    );
    return undefined;
  }

  const selected = await prompt(() =>
    p.multiselect({
      message: "Which agent programs should akm use? (agent work runs on them)",
      options: candidates.map((platform) => ({
        value: platform,
        label: getHarness(platform)?.displayName ?? platform,
        hint: `${installed.find((harness) => harness.platform === platform)?.path ?? "not found on PATH"}; ${readOnlyNote(platform)}`,
      })),
      initialValues: configured.length > 0 ? [...configured] : installedPlatforms,
      required: false,
    }),
  );
  if (selected.length === 0) return { platforms: [] };

  const wanted = currentDefaultPlatform(current);
  const initialValue = wanted && selected.includes(wanted) ? wanted : selected[0];
  const chosen =
    selected.length === 1
      ? selected[0]
      : await prompt(() =>
          p.select({
            message: "Which one should agent work run on by default?",
            options: selected.map((platform) => ({
              value: platform,
              label: getHarness(platform)?.displayName ?? platform,
            })),
            initialValue,
          }),
        );
  return { platforms: selected, default: chosen as string };
}
