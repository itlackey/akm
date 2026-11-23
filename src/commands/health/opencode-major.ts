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

/** What the version probe found out about a binary that did not report an OpenCode version. */
function unreadableDetail(harness: { name: string; bin: string; runnable: boolean; version: string }): string {
  const found = harness.runnable
    ? `printed "${harness.version.split("\n")[0]}", not an OpenCode version`
    : "could not be run";
  return `harness "${harness.name}" (${harness.bin}) ${found}`;
}

/**
 * The advisory for OpenCode 1 harnesses, or `undefined` when there are no `opencode` harnesses to report. Without
 * `probe` no binary is run (`--no-probe`): the harnesses are named and their major is unknown.
 */
export function collectOpencodeMajorAdvisory(probe: boolean): HealthCheckResult | undefined {
  const base = { name: "opencode-major", kind: "deterministic", confidence: "high" } as const;
  const harnesses = opencodeHarnesses();
  if (harnesses.length === 0) return undefined;
  if (!probe) {
    return {
      ...base,
      status: "unknown",
      reason: "not-probed",
      message: `Not probed: whether ${harnesses.map((harness) => `harness "${harness.name}" (${harness.bin})`).join(", ")} is OpenCode 1 (removed in 0.11) needs its \`--version\`; run without --no-probe.`,
    };
  }
  const found = harnesses.map((harness) => ({ ...harness, ...detectOpencodeMajor(harness.bin) }));
  const unreadable = found.filter((harness) => harness.reportedMajor === undefined);
  const opencode1 = found.filter((harness) => harness.reportedMajor === 1);
  const unreadableNote =
    unreadable.length > 0
      ? ` Could not tell whether the other harnesses are OpenCode 1: ${unreadable.map(unreadableDetail).join("; ")}.`
      : "";
  if (opencode1.length > 0) {
    return {
      ...base,
      status: "warn",
      message:
        opencode1
          .map((harness) => `Harness "${harness.name}": ${opencode1DeprecationNotice(harness.bin, harness.version)}`)
          .join(" ") + unreadableNote,
      evidence: {
        harnesses: opencode1.map(({ name, bin, version }) => ({ name, bin, version })),
        unreadable: unreadable.map(({ name, bin, runnable, version }) => ({ name, bin, runnable, version })),
      },
    };
  }
  if (unreadable.length > 0) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `${unreadable.map(unreadableDetail).join("; ")}, so whether it is OpenCode 1 (removed in 0.11) is not known.`,
    };
  }
  return undefined;
}
