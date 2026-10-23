// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { parseEnvRef } from "../../core/env-secret-ref";
import { UsageError } from "../../core/errors";
import { resolveConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import type { FrozenWorkflowEnvironmentBinding, WorkflowExec } from "../plan";
import type { FreezeStep, ResolutionContext } from "./step-values";

/**
 * A step's frozen environment: `pass_env` names, then one bundle-qualified
 * ref per `unit.env` entry. The env file, its keys and the secrets it names
 * are read at dispatch (`exec/environment.ts`), never frozen.
 */
export function freezeEnvironment(
  source: FreezeStep,
  exec: WorkflowExec | undefined,
  context: ResolutionContext,
): FrozenWorkflowEnvironmentBinding[] {
  const passThrough = (exec?.passEnv ?? []).map((name) => Object.freeze({ kind: "pass-through" as const, name }));
  const seen = new Set<string>();
  const envRefs: FrozenWorkflowEnvironmentBinding[] = [];
  for (const [precedence, ref] of (source.unit?.env ?? []).entries()) {
    parseEnvRef(ref);
    const qualified = qualifyEnvRef(ref, context);
    if (seen.has(qualified)) continue;
    seen.add(qualified);
    envRefs.push(Object.freeze({ kind: "env-ref" as const, ref: qualified, precedence }));
  }
  return [...passThrough, ...envRefs];
}

/** Qualify an env ref a step names with the bundle that owns it right now, through the one walk. */
function qualifyEnvRef(refInput: string, context: ResolutionContext): string {
  const parsed = parseBundleRef(refInput);
  const match = resolveConceptOwner(
    { bundle: parsed.bundle, conceptId: parsed.conceptId },
    resolveSourceEntries(undefined, context.config),
    { includeSensitive: true },
  );
  if (!match) throw new UsageError(`Workflow source target ${refInput} was not found.`, "INVALID_FLAG_VALUE");
  return makeBundleRef(match.bundleId, parsed.conceptId);
}
