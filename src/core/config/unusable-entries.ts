// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ZodError } from "zod";
import { isRecord } from "../common";
import { warnOnce } from "../warn";
import { ConnectionSchema } from "./schema/connections";
import { HarnessSchema, harnessNameProblem } from "./schema/harnesses";

type Dict = Record<string, unknown>;

/** The first thing a schema found wrong with an entry, as a sentence fragment. */
function firstIssue(error: ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return `${where ? `${where}: ` : ""}${issue?.message ?? "it is not valid"}`;
}

/** Why a connection entry cannot be used, if it cannot: its own schema rejects it. */
function connectionProblem(_name: string, entry: unknown): string | undefined {
  const parsed = ConnectionSchema.safeParse(entry);
  return parsed.success ? undefined : firstIssue(parsed.error);
}

/** Why a harness entry cannot be used, if it cannot: its own schema rejects it, or it names no platform and is not one. */
function harnessProblem(name: string, entry: unknown): string | undefined {
  const parsed = HarnessSchema.safeParse(entry);
  return parsed.success ? harnessNameProblem(name, parsed.data) : firstIssue(parsed.error);
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
 * A connection or harness its own schema rejects (no endpoint, an endpoint that
 * is not a URL, a model that is not a name, a harness akm cannot run) is of no
 * use, but it is not a reason to refuse the rest of the config or to disable the
 * entries beside it: each is dropped from what is read, with one warning naming
 * it and the first thing wrong. The file keeps it, and a write does not remove it.
 */
export function dropUnusableEntries(raw: Dict, sourcePath?: string): Dict {
  const out = { ...raw };
  if (raw.connections !== undefined) {
    out.connections = usableEntries(raw.connections, "connection", connectionProblem, sourcePath);
  }
  if (raw.harnesses !== undefined) out.harnesses = usableEntries(raw.harnesses, "harness", harnessProblem, sourcePath);
  return out;
}
