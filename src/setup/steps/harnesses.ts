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
import { prompt } from "../prompt";
import type { SetupFlags } from "../setup-flags";
import { type HarnessAnswer, harnessEntries } from "../setup-plan";
import { runsReadOnly, unrestrictedModelWorkNote } from "../summary";

export interface HarnessStepResult {
  /** Absent: the harnesses stay as they are. */
  answer?: HarnessAnswer;
  /** Whether model calls need no connection because the harness takes them. */
  modelCallsOnHarness: boolean;
  /**
   * The answer to "may the default harness take akm's own model calls": absent when it was not a question (a
   * connection exists or is being added, or there is no harness). `false` is for the config to keep (see
   * `harnessModelWork`) when no connection is added after all.
   */
  modelWork?: boolean;
}

export interface HarnessStepInput {
  current: AkmConfig;
  installed: readonly InstalledHarness[];
  flags: SetupFlags;
  interactive: boolean;
}

function readOnlyNote(platform: string, bin?: string): string {
  return runsReadOnly(platform, bin) ? "model calls run read-only" : "model calls cannot be restricted to read-only";
}

function configuredPlatforms(current: AkmConfig): string[] {
  return [...new Set(Object.entries(current.harnesses ?? {}).map(([name, harness]) => harness.platform ?? name))];
}

/** The platform agent work runs on in the config, if any. */
function currentDefaultPlatform(current: AkmConfig): string | undefined {
  const found = defaultHarness(current);
  return found ? (found.harness.platform ?? found.name) : undefined;
}

/** The `bin` the config sets for the first entry of `platform`, if it sets one: the program setup will judge. */
function configuredBin(current: AkmConfig, platform: string): string | undefined {
  return Object.entries(current.harnesses ?? {}).find(([name, harness]) => (harness.platform ?? name) === platform)?.[1]
    .bin;
}

/** The harness agent work runs on once `answer` is applied: the entry the config will hold, with its own `bin`. */
function selectedHarness(current: AkmConfig, answer: HarnessAnswer | undefined) {
  const harnesses = answer ? harnessEntries(current.harnesses, answer.platforms, answer.default) : current.harnesses;
  return defaultHarness({ harnesses } as AkmConfig);
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
  // `modelWork` is whether the default harness may take akm's model calls, once that has been decided.
  const result = (modelCallsOnHarness: boolean, modelWork?: boolean): HarnessStepResult => ({
    ...(answer ? { answer } : {}),
    modelCallsOnHarness,
    ...(modelWork !== undefined ? { modelWork } : {}),
  });

  // Model calls can go to a harness only when one is enabled and no connection exists or is being added.
  const selected = selectedHarness(current, answer);
  if (selected === undefined || defaultConnection(current) !== undefined || flags.endpoint !== undefined) {
    return result(false);
  }
  const defaultPlatform = selected.harness.platform ?? selected.name;
  const readOnly = runsReadOnly(defaultPlatform, selected.harness.bin);
  // A saved `modelWork: false` is the user's choice: only the question's "yes" changes it, never a default.
  const declined = selected.harness.modelWork === false;
  if (!input.interactive) return declined ? result(false, false) : result(readOnly, readOnly);
  const yes = await prompt(() =>
    p.confirm({
      message: `Use ${defaultPlatform} for akm's own model calls too (improve, judging, extraction)? ${readOnly ? "Model calls run read-only." : unrestrictedModelWorkNote(defaultPlatform)}`,
      initialValue: !declined,
    }),
  );
  // Said again once it is chosen, so it stays in the transcript beside the answer.
  if (yes && !readOnly) p.log.warn(unrestrictedModelWorkNote(defaultPlatform));
  return result(yes, yes);
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
        hint: `${installed.find((harness) => harness.platform === platform)?.path ?? "not found on PATH"}; ${readOnlyNote(platform, configuredBin(current, platform))}`,
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
