// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { typeNameFromConceptId } from "../../core/asset/resolve-ref";
import { compareCodePoints, toPosix } from "../../core/common";
import { parseEnvRef } from "../../core/env-secret-ref";
import { UsageError } from "../../core/errors";
import { isRefToken, REF_TOKEN_RE } from "../../core/ref-token";
import { resolveConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import type { FrozenWorkflowEnvironmentBinding, WorkflowExec } from "../plan";
import type { FreezeStep, OwnedAsset, ResolutionContext } from "./step-values";

/**
 * A step's frozen environment: `pass_env` names, then
 * one value-free descriptor per `unit.env` ref (owner, key set, secret refs).
 * Values are read at dispatch (`exec/environment.ts`), never frozen.
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
    const owned = resolveOwnedAssetSync(ref, context);
    if (seen.has(owned.ref)) continue;
    seen.add(owned.ref);
    const parsed = dotenv.parse(fs.readFileSync(owned.file));
    const secretNames = new Set<string>();
    for (const value of Object.values(parsed)) {
      for (const [token, body] of value.matchAll(REF_TOKEN_RE)) {
        if (body && isRefToken(token) && typeNameFromConceptId(parseBundleRef(body).conceptId)?.type === "secret") {
          secretNames.add(body);
        }
      }
    }
    envRefs.push(
      Object.freeze({
        kind: "env-ref" as const,
        ref: owned.ref,
        owner: Object.freeze({
          bundle: owned.bundle,
          adapter: owned.adapter,
          requestedRoot: owned.root,
          requestedPath: owned.file,
          relativePath: toPosix(path.relative(owned.root, owned.file)),
        }),
        keys: Object.keys(parsed).sort(compareCodePoints),
        secretNames: [...secretNames].sort(compareCodePoints),
        precedence,
      }),
    );
  }
  return [...passThrough, ...envRefs];
}

/** Resolve an env ref a step names to the file that owns it, through the one walk. */
export function resolveOwnedAssetSync(refInput: string, context: ResolutionContext): OwnedAsset {
  const parsed = parseBundleRef(refInput);
  const match = resolveConceptOwner(
    { bundle: parsed.bundle, conceptId: parsed.conceptId },
    resolveSourceEntries(undefined, context.config),
    { includeSensitive: true },
  );
  if (!match) throw new UsageError(`Workflow source target ${refInput} was not found.`, "INVALID_FLAG_VALUE");
  return {
    ref: makeBundleRef(match.bundleId, parsed.conceptId),
    bundle: match.bundleId,
    adapter: match.adapterId,
    root: match.source.path,
    file: match.owner.path,
  };
}
