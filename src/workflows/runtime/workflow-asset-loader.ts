// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { adapterWrites } from "../../core/assets/gate";
import { findAsset } from "../../core/assets/read";
import { assetType } from "../../core/assets/type";
import { loadConfig } from "../../core/config/config";
import { COMPOSITION_INVALID_MULTI_JOB_HINT, NotFoundError, UsageError } from "../../core/errors";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { sourceOfBundle } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { compileWorkflowSource } from "../compile";
import type { WorkflowPlan } from "../plan";

/** A resolved workflow asset, compiled from either authored format into its plan. */
export type WorkflowAsset = {
  ref: string;
  path: string;
  /** Run-level display title: the asset's canonical name (a step is its id; there are no authored titles). */
  title: string;
  /** The compiled, not-yet-frozen plan. */
  plan: WorkflowPlan;
  /** sha256 of the source bytes the plan was compiled from. */
  sourceHash: string;
};

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
  canonicalName: string;
  fullRef: string;
};

/** Resolve a workflow ref to its authored file and canonical run ref. */
function resolveWorkflowAsset(ref: string): ResolvedWorkflowAsset {
  const bundleRef = parseWorkflowRefInput(ref);

  const sources = resolveSourceEntries(undefined, loadConfig());
  const asset = findAsset(bundleRef, { sources });
  if (!asset) {
    if (bundleRef.bundle && resolveSourcesForOrigin(bundleRef.bundle, sources).length === 0) {
      throw new UsageError(
        `Bundle "${bundleRef.bundle}" was not found among configured sources.`,
        "WORKFLOW_SOURCE_INVALID",
      );
    }
    throw new NotFoundError(`Workflow not found for ref: ${ref}`);
  }
  const bundleId = asset.bundle;
  const source = sourceOfBundle(sources, bundleId);
  // A workflow runs when its bundle's adapter holds workflows as its own: a read-only adapter's workflow is a document.
  const type = assetType(asset);
  if (
    type !== "workflow" ||
    !adapterWrites(
      {
        name: bundleId,
        path: source.path,
        ...(source.location !== undefined ? { location: source.location } : {}),
        ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
      },
      "workflow",
    )
  ) {
    throw new UsageError(
      `${asset.ref} is not a native workflow: bundle "${bundleId}" holds it as a ${type} it does not run.`,
      "WORKFLOW_SOURCE_INVALID",
    );
  }
  const assetPath = asset.entry.file;
  if (assetPath === undefined) throw new UsageError(`Asset ${asset.ref} is not kept in a file.`);

  // Canonicalize the stored ref: `workflows/foo.md` and `workflows/foo` resolve
  // to the same file, so they MUST share one run identity.
  const canonicalName = canonicalizeWorkflowName(asset.conceptId);
  const fullRef = makeBundleRef(bundleId, canonicalName);

  return { assetPath, sourcePath: source.path, canonicalName, fullRef };
}

/**
 * The root of the bundle that owns a workflow ref right now: where the run's exec units and agents work.
 * A bundle-qualified ref names its bundle, so the workflow file need not exist (a bundle update may have
 * renamed or removed it; the frozen plan is the run's authority). An unqualified legacy ref finds its
 * owner by the existing walk. When the bundle does not resolve, the error keeps its type (and exit code)
 * and names the ref in its message.
 */
export function resolveRunBundleRoot(ref: string): string {
  const { bundle } = parseWorkflowRefInput(ref);
  if (bundle === undefined) {
    try {
      return resolveWorkflowAsset(ref).sourcePath;
    } catch (err) {
      // Only a miss means the bundle does not resolve; any other error (an
      // unsupported adapter, a collision) is reported as itself.
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`workflow ${ref} does not resolve to a bundle: ${err.message}`, err.code, err.hint());
      }
      throw err;
    }
  }
  const source = resolveSourcesForOrigin(bundle, resolveSourceEntries(undefined, loadConfig()))[0];
  if (!source) {
    throw new UsageError(
      `workflow ${ref} does not resolve to a bundle: bundle "${bundle}" is not configured`,
      "WORKFLOW_SOURCE_INVALID",
    );
  }
  return source.path;
}

/**
 * Resolve a workflow ref and compile its authored bytes into a plan.
 */
export async function loadWorkflowAsset(ref: string): Promise<WorkflowAsset> {
  const { assetPath, canonicalName, fullRef } = resolveWorkflowAsset(ref);
  const title = canonicalName.split("/").pop() || canonicalName;
  const bytes = fs.readFileSync(assetPath);
  const result = compileWorkflowSource(bytes.toString("utf8"), {
    path: assetPath,
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
    title,
    plan: result.plan,
    sourceHash: createHash("sha256").update(bytes).digest("hex"),
  };
}
