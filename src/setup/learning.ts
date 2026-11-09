// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Background learning: one host-wide switch, `improve.enabled`. `akm improve` and `akm proposal extract` do nothing
 * while it is `false`. `akm info` reads it; `akm setup --learning` and the workspace `setup.apply` write it.
 */

import { assertUnsettable, setConfigValue, unsetConfigValue } from "../commands/config-cli";
import { targetRows } from "../commands/targets";
import { makeBundleRef } from "../core/asset/asset-ref";
import { type AkmConfig, loadConfig, mutateConfig, resetConfigCache } from "../core/config/config";
import { IMPROVE_ENGINE_PROCESSES } from "../core/config/engine-semantics";
import { resolveWriteTarget } from "../core/write-source";
import { schedulerEnabledRefs } from "../tasks/activation-config";

/**
 * Hosts that turned learning off before `improve.enabled` existed (Desktop's "off") hold all seven model-calling
 * processes `enabled: false` on the active strategy. That reads as off, and `on` clears it. A partial set is the
 * person's own and is left alone.
 */
function legacyOff(config: AkmConfig): string[] {
  const name = config.improve?.strategy ?? "default";
  const processes = config.improve?.strategies?.[name]?.processes as Record<string, { enabled?: boolean }> | undefined;
  const keys = IMPROVE_ENGINE_PROCESSES.map((process) => `improve.strategies.${name}.processes.${process}.enabled`);
  return IMPROVE_ENGINE_PROCESSES.every((process) => processes?.[process]?.enabled === false) ? keys : [];
}

/**
 * Background learning as the config reads it: `on` is the switch alone (not whether anything is set up to run);
 * `harness` is the platform improve runs on, `null` when it runs on a connection or nowhere; `scheduled` is whether the
 * `improve` task is enabled. Reads the config and the bundle's task location only: nothing is probed or written.
 */
export function learningStatus(config: AkmConfig = loadConfig()) {
  const rows = targetRows({ config });
  const improve = rows.find((row) => row.type === "process" && row.process === "improve");
  const harness =
    improve?.type === "process" && improve.kind === "harness"
      ? rows.find((row) => row.type === "harness" && row.name === improve.target)
      : undefined;
  let scheduled = false;
  try {
    if (config.defaultBundle) {
      const source = resolveWriteTarget(config, config.defaultBundle, { requireWritable: false }).source;
      scheduled = new Set(schedulerEnabledRefs(config)).has(makeBundleRef(source.name, "tasks/improve"));
    }
  } catch {
    // No usable bundle: nothing is scheduled.
  }
  return {
    on: config.improve?.enabled !== false && legacyOff(config).length === 0,
    harness: harness?.type === "harness" ? harness.platform : null,
    scheduled,
  };
}

/** Turn learning off (`improve.enabled: false`) or on (remove it, and any legacy off). Nothing else is written. */
export function setLearning(on: boolean) {
  mutateConfig(
    (current) => {
      if (!on) return setConfigValue(current, "improve.enabled", "false");
      let updated = current;
      for (const key of ["improve.enabled", ...legacyOff(current)]) {
        assertUnsettable(key);
        updated = unsetConfigValue(updated, key);
      }
      return updated;
    },
    { absentNoop: on },
  );
  resetConfigCache();
  return learningStatus();
}
