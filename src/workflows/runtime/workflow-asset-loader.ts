// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { COMPOSITION_INVALID_MULTI_JOB_HINT, NotFoundError, UsageError } from "../../core/errors";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { deriveInstallations } from "../../indexer/installations";
import { resolveAdapterConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { compileWorkflowSource } from "../compile";
import type { WorkflowPlan } from "../plan";

/** A resolved workflow asset, compiled from either authored format into its plan. */
export type WorkflowAsset = {
  ref: string;
  path: string;
  sourcePath: string;
  adapterId?: string;
  /** Run-level display title: the asset's canonical name (a step is its id; there are no authored titles). */
  title: string;
  /** The compiled, not-yet-frozen plan. */
  plan: WorkflowPlan;
  /** sha256 of the source bytes the plan was compiled from. */
  sourceHash: string;
};

/**
 * Build the canonical `workflow_runs.workflow_ref` for an AKM workflow asset.
 */
export function canonicalWorkflowRunRef(bundle: string | undefined, canonicalName: string): string {
  return makeBundleRef(bundle, `workflows/${canonicalName}`);
}

/** Parse a workflow ref using the canonical `[bundle//]conceptId` grammar. */
export function parseWorkflowRefInput(ref: string): BundleRef {
  const parsed = parseBundleRef(ref.trim());
  if (parsed.fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${parsed.fragment}" is not accepted in a workflow ref.`,
      "TARGET_REF_INVALID",
    );
  }
  if (parsed.conceptId.startsWith("workflow:")) {
    throw new UsageError(
      `Invalid workflow ref "${ref.trim()}". Use [bundle//]conceptId, such as workflows/release.`,
      "TARGET_REF_INVALID",
    );
  }
  return parsed;
}

/** Resolve input sugar to the workflow's canonical run identity, without compiling it. */
export async function canonicalizeWorkflowRefInput(ref: string): Promise<string> {
  return resolveWorkflowAsset(ref).fullRef;
}

type ResolvedWorkflowAsset = {
  assetPath: string;
  sourcePath: string;
  adapterId: string;
  canonicalName: string;
  fullRef: string;
};

/** Resolve a workflow ref to its authored file and canonical run ref. */
function resolveWorkflowAsset(ref: string): ResolvedWorkflowAsset {
  const bundleRef = parseWorkflowRefInput(ref);

  const config = loadConfig();
  const allSources = resolveSourceEntries(undefined, config);
  const installations = deriveInstallations(allSources);
  const searchSources = allSources.flatMap((source, index) => {
    const bundleId = installations[index]?.id;
    if (!bundleId || (bundleRef.bundle !== undefined && bundleRef.bundle !== bundleId)) return [];
    return [{ source, bundleId }];
  });
  if (bundleRef.bundle && searchSources.length === 0) {
    throw new UsageError(
      `Bundle "${bundleRef.bundle}" was not found among configured sources.`,
      "WORKFLOW_SOURCE_INVALID",
    );
  }
  let assetPath: string | undefined;
  let sourcePath: string | undefined;
  let sourceBundleId: string | undefined;
  let workflowName: string | undefined;
  let workflowAdapterId: string | undefined;
  let rejectedSource: { source: SearchSource; bundleId: string } | undefined;

  for (const candidateSource of searchSources) {
    const { source, bundleId } = candidateSource;
    const adapterId = source.adapterId ?? detectAdapterId(source.path);
    const ownedSource = source.adapterId ? source : { ...source, adapterId };
    const owner = resolveAdapterConceptOwner(source.path, adapterId, bundleRef.conceptId);
    if (!owner) continue;
    if (!ownsNativeWorkflowRuntime(ownedSource) || !owner.workflowSource) {
      rejectedSource ??= { source: ownedSource, bundleId };
      break;
    }
    assetPath = owner.path;
    sourcePath = source.path;
    sourceBundleId = bundleId;
    workflowName = owner.workflowSource.canonicalName;
    workflowAdapterId = adapterId;
    break;
  }

  if (!assetPath) {
    if (rejectedSource) {
      const sourceName = rejectedSource.bundleId;
      const adapterId = rejectedSource.source.adapterId ?? "unassigned";
      throw new UsageError(
        `Bundle "${sourceName}" uses adapter "${adapterId}", which does not support native workflow execution.`,
        "WORKFLOW_SOURCE_INVALID",
      );
    }
    throw new NotFoundError(`Workflow not found for ref: ${ref}`);
  }

  // Canonicalize the stored ref: `workflows/foo.md` and `workflows/foo` resolve
  // to the same file, so they MUST share one run identity.
  const canonicalName = canonicalizeWorkflowName(workflowName as string);
  const fullRef =
    workflowAdapterId === "akm-workflow"
      ? makeBundleRef(sourceBundleId, canonicalName)
      : canonicalWorkflowRunRef(sourceBundleId, canonicalName);

  return {
    assetPath,
    sourcePath: sourcePath as string,
    adapterId: workflowAdapterId as string,
    canonicalName,
    fullRef,
  };
}

/**
 * Resolve a workflow ref and compile its authored bytes into a plan.
 */
export async function loadWorkflowAsset(ref: string): Promise<WorkflowAsset> {
  const { assetPath, sourcePath, adapterId, canonicalName, fullRef } = resolveWorkflowAsset(ref);
  const title = canonicalName.split("/").pop() || canonicalName;
  const bytes = fs.readFileSync(assetPath);
  const result = compileWorkflowSource(bytes.toString("utf8"), {
    path: assetPath,
    workspaceRoot: sourcePath,
    title,
  });
  if (!result.ok) {
    const details = result.errors.map((error) => `  ${error.path}:${error.line} — ${error.message}`).join("\n");
    const isMultiJob = result.errors.length === 1 && result.errors[0]?.code === "multi-job-unsupported";
    throw new UsageError(
      `Workflow source has ${result.errors.length} error(s):\n${details}`,
      isMultiJob ? "COMPOSITION_INVALID" : "WORKFLOW_SOURCE_INVALID",
      isMultiJob ? COMPOSITION_INVALID_MULTI_JOB_HINT : undefined,
    );
  }
  return {
    ref: fullRef,
    path: assetPath,
    sourcePath,
    adapterId,
    title,
    plan: result.plan,
    sourceHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

function ownsNativeWorkflowRuntime(source: SearchSource): boolean {
  return source.adapterId === "akm" || source.adapterId === "akm-workflow";
}
