// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { HARNESS_CONFIG_PLATFORMS } from "../../integrations/harnesses";
import { isRecord } from "../common";
import { warnOnce } from "../warn";

type Dict = Record<string, unknown>;

/** Why a connection entry cannot be used, if it cannot. */
function connectionProblem(entry: unknown): string | undefined {
  if (!isRecord(entry) || typeof entry.endpoint !== "string" || entry.endpoint.trim() === "") {
    return "it has no endpoint";
  }
  return undefined;
}

/** Why a harness entry cannot be used, if it cannot. */
function harnessProblem(name: string, entry: unknown): string | undefined {
  const platforms = HARNESS_CONFIG_PLATFORMS as readonly string[];
  const platform = isRecord(entry) ? entry.platform : undefined;
  if (platform !== undefined) {
    return typeof platform === "string" && platforms.includes(platform)
      ? undefined
      : `${JSON.stringify(platform)} is not a platform akm runs (${platforms.join(", ")})`;
  }
  return platforms.includes(name) ? undefined : `it names no platform and is not itself one (${platforms.join(", ")})`;
}

function usableEntries(
  entries: unknown,
  kind: "connection" | "harness",
  problem: (name: string, entry: unknown) => string | undefined,
  sourcePath: string | undefined,
): unknown {
  if (!isRecord(entries)) return entries;
  const kept: Dict = {};
  for (const [name, entry] of Object.entries(entries)) {
    const why = problem(name, entry);
    if (why === undefined) {
      kept[name] = entry;
      continue;
    }
    warnOnce(
      `config:unusable:${kind}:${sourcePath ?? "inline"}:${name}`,
      `Ignoring ${kind} "${name}"${sourcePath ? ` in ${sourcePath}` : ""}: ${why}.`,
    );
  }
  return kept;
}

/**
 * A connection with no endpoint and a harness akm cannot run are of no use, but
 * they are not a reason to refuse the rest of the config (or to disable the
 * entries beside them): each is dropped from what is read, with one warning
 * naming it. The file keeps it, and a write does not remove it.
 */
export function dropUnusableEntries(raw: Dict, sourcePath?: string): Dict {
  const out = { ...raw };
  if (raw.connections !== undefined) {
    out.connections = usableEntries(raw.connections, "connection", (_, entry) => connectionProblem(entry), sourcePath);
  }
  if (raw.harnesses !== undefined) out.harnesses = usableEntries(raw.harnesses, "harness", harnessProblem, sourcePath);
  return out;
}
