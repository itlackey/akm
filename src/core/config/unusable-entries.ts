// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ZodError } from "zod";
import { isRecord } from "../common";
import { warnOnce } from "../warn";
import { ConnectionSchema } from "./schema/connections";
import { HarnessSchema, harnessNameProblem } from "./schema/harnesses";
import { engineName } from "./schema/primitives";

type Dict = Record<string, unknown>;

/** The first thing a schema found wrong with an entry, as a sentence fragment. */
function firstIssue(error: ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return `${where ? `${where}: ` : ""}${issue?.message ?? "it is not valid"}`;
}

/** Why an entry cannot have this name, if it cannot: the rule every connection and harness name follows. */
function nameProblem(name: string): string | undefined {
  const parsed = engineName.safeParse(name);
  return parsed.success ? undefined : `its name breaks the naming rule (${firstIssue(parsed.error)})`;
}

/** Why a connection entry cannot be used, if it cannot: its name breaks the rule, or its own schema rejects it. */
function connectionProblem(name: string, entry: unknown): string | undefined {
  const parsed = ConnectionSchema.safeParse(entry);
  return nameProblem(name) ?? (parsed.success ? undefined : firstIssue(parsed.error));
}

/** Why a harness entry cannot be used, if it cannot: as for a connection, or it names no platform and is not one. */
function harnessProblem(name: string, entry: unknown): string | undefined {
  const parsed = HarnessSchema.safeParse(entry);
  return nameProblem(name) ?? (parsed.success ? harnessNameProblem(name, parsed.data) : firstIssue(parsed.error));
}

export interface UnusableEntry {
  readonly kind: "connection" | "harness";
  readonly name: string;
  /** The first thing wrong with it. */
  readonly why: string;
}

/** The connections and harnesses of `raw` that their own schemas reject, in file order. */
export function findUnusableEntries(raw: Dict): UnusableEntry[] {
  const unusable: UnusableEntry[] = [];
  const check = (
    entries: unknown,
    kind: UnusableEntry["kind"],
    problem: (name: string, entry: unknown) => string | undefined,
  ): void => {
    if (!isRecord(entries)) return;
    for (const [name, entry] of Object.entries(entries)) {
      const why = problem(name, entry);
      if (why !== undefined) unusable.push({ kind, name, why });
    }
  };
  check(raw.connections, "connection", connectionProblem);
  check(raw.harnesses, "harness", harnessProblem);
  return unusable;
}

/**
 * A connection or harness its own schema rejects (no endpoint, an endpoint that
 * is not a URL, a model that is not a name, a harness akm cannot run, a name that
 * breaks the naming rule) is of no
 * use, but it is not a reason to refuse the rest of the config or to disable the
 * entries beside it: each is dropped from what is read, with one warning naming
 * it and the first thing wrong. The file keeps it, and a write does not remove it.
 */
export function dropUnusableEntries(raw: Dict, sourcePath?: string): Dict {
  const unusable = findUnusableEntries(raw);
  if (unusable.length === 0) return raw;
  const out = { ...raw };
  for (const { kind, name, why } of unusable) {
    warnOnce(
      `config:unusable:${kind}:${sourcePath ?? "inline"}:${name}`,
      `Ignoring ${kind} "${name}"${sourcePath ? ` in ${sourcePath}` : ""}: ${why}.`,
    );
    const holder = kind === "connection" ? "connections" : "harnesses";
    const { [name]: _dropped, ...kept } = out[holder] as Dict;
    out[holder] = kept;
  }
  return out;
}
