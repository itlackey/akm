// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `opencode-major` advisory for `akm health` / `akm doctor`: OpenCode 1 is removed in 0.11. The run notice is silenced
 * for scheduled and task runs, where most OpenCode use is, so doctor says it for every configured `opencode` harness
 * whose binary reports major 1. Silent when none does; a binary whose version cannot be read is unknown, never fine.
 */

import { opencode1DeprecationNotice } from "../../cli/deprecations";
import { loadConfig } from "../../core/config/config";
import { detectOpencodeMajor } from "../../integrations/harnesses/opencode/version";
import { targetRows } from "../targets";
import type { HealthCheckResult } from "./types";

/** The installed harnesses on the `opencode` platform, by name and binary (a harness not on PATH is `connections-and-harnesses`' finding). */
function opencodeHarnesses(): { name: string; bin: string }[] {
  return targetRows({ config: loadConfig() }).flatMap((row) =>
    row.type === "harness" && row.platform === "opencode" && row.installed ? [{ name: row.name, bin: row.bin }] : [],
  );
}

/** The advisory for OpenCode 1 harnesses, or `undefined` when there are none to report. */
export function collectOpencodeMajorAdvisory(): HealthCheckResult | undefined {
  const base = { name: "opencode-major", kind: "deterministic", confidence: "high" } as const;
  const found = opencodeHarnesses().map((harness) => ({ ...harness, ...detectOpencodeMajor(harness.bin) }));
  const unreadable = found.filter((harness) => harness.reportedMajor === undefined);
  const opencode1 = found.filter((harness) => harness.reportedMajor === 1);
  if (opencode1.length > 0) {
    return {
      ...base,
      status: "warn",
      message: opencode1
        .map((harness) => `Harness "${harness.name}": ${opencode1DeprecationNotice(harness.bin, harness.version)}`)
        .join(" "),
      evidence: { harnesses: opencode1.map(({ name, bin, version }) => ({ name, bin, version })) },
    };
  }
  if (unreadable.length > 0) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `Could not read the OpenCode version of ${unreadable.map((harness) => `harness "${harness.name}" (${harness.bin})`).join(", ")}, so whether it is OpenCode 1 (removed in 0.11) is not known. Check \`${unreadable[0]?.bin} --version\`.`,
    };
  }
  return undefined;
}
