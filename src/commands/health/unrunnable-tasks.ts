// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `unrunnable-tasks` advisory for `akm health`: an enabled task that `akm task dispatch` cannot read or schedule
 * (a deleted file, an inactive bundle, a schedule the cron grammar rejects). Dispatch reports each one every minute,
 * but only in `dispatch.log`, which is rewritten every minute; nothing else would say the task has stopped.
 */

import { loadConfig } from "../../core/config/config";
import { unrunnableTasks } from "../../tasks/dispatch";
import type { HealthCheckResult } from "./types";

export function collectUnrunnableTasksAdvisory(): HealthCheckResult {
  let failures: { ref: string; reason: string }[];
  try {
    failures = unrunnableTasks(loadConfig());
  } catch (error) {
    return {
      name: "unrunnable-tasks",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: `Enabled tasks could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (failures.length === 0) {
    return {
      name: "unrunnable-tasks",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: "Every enabled task can be read and scheduled.",
    };
  }
  return {
    name: "unrunnable-tasks",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `${failures.length} enabled task(s) cannot run: ${failures.map((f) => `${f.ref} (${f.reason})`).join("; ")}`,
    evidence: { failures },
  };
}
