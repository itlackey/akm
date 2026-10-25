// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Load and project one task asset into immutable executable work: id
 * validation, adapter detection, owner resolution, source read, strict task
 * source parsing, config selection, bundle-name resolution, and the
 * `prepareTaskV3Execution` call. Everything here is non-mutating — run-task.ts
 * reserves a durable attempt only after this resolves.
 */

import fs from "node:fs";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { conceptIdFromTypeName } from "../../core/asset/resolve-ref";
import { resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { bundleKeyForContentRoot } from "../../core/config/config-sources";
import type { AkmConfig } from "../../core/config/config-types";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { assertBundleNotDisabled } from "../../core/write-source";
import {
  applyInputDefaults,
  type InputContract,
  materializeInputFlags,
  type TaskInputBinding,
  validateInputs,
} from "../../execution/input-contract";
import type { ExecutionJsonObject } from "../../execution/json";
import { resolveAdapterConceptOwner, resolveConceptOwner } from "../../indexer/lookup/adapter-concept-owner";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { resolveAssetPath } from "../../sources/resolve";
import type { TaskInvocation } from "../model/invocation";
import { prepareTaskV3Execution } from "../prepare/prepare";
import type { PreparedTaskV3Execution } from "../prepare/prepared-execution";
import { scheduledTaskContextEnv } from "../scheduler-invocation";
import { parseTaskSource } from "../source/parse-task-source";
import { projectTaskSourceV4 } from "../source/project-v4";
import { TASK_INPUT_DIAGNOSTICS } from "../source/task-input-diagnostics";
import { validateTaskConceptId, validateTaskId } from "../task-id";
import type { RunTaskOptions } from "./task-result";

/**
 * The literal bundle-name fallback, hoisted to a named constant. The value is
 * user-visible data, so it must not change.
 */
export const DEFAULT_BUNDLE_NAME = "stash";

const CONFIG_FREE_TASK_RUNTIME: AkmConfig = Object.freeze({
  configVersion: "0.9.0",
  semanticSearchMode: "off",
});

/**
 * The active source set a task read walks. A working stash that is a disabled
 * configured bundle makes that set throw; it is simply not in the set, so the
 * other bundles still resolve.
 */
export function activeTaskSources(config: AkmConfig): SearchSource[] {
  try {
    return resolveSourceEntries(undefined, config);
  } catch (cause) {
    const working = bundleKeyForContentRoot(config, resolveStashDir());
    const entry = working ? config.bundles?.[working] : undefined;
    if (!(cause instanceof ConfigError) || !working || !entry || entry.enabled !== false) throw cause;
    const enabled = { ...config, bundles: { ...config.bundles, [working]: { ...entry, enabled: true } } };
    return resolveSourceEntries(undefined, enabled).filter((source) => source.registryId !== working);
  }
}

/**
 * Resolve an asset a task names in another bundle (`uses:`) through the one
 * ref-to-file walk. Reading needs no write target, so a bundle of any kind
 * (git, npm, website) resolves. The file is the authored path, not the symlink
 * target, so the script interpreter follows the name the author gave it.
 */
export function resolveBundleAsset(
  config: AkmConfig,
  { bundle, type, name }: { bundle: string; type: string; name: string },
): { file: string; bundleRoot: string } {
  const conceptId = conceptIdFromTypeName(type, name);
  const sources = activeTaskSources(config);
  const match = resolveConceptOwner({ bundle, conceptId }, sources);
  if (match) return { file: match.owner.path, bundleRoot: match.source.path };
  if (resolveSourcesForOrigin(bundle, sources).length === 0) {
    assertBundleNotDisabled(config, bundle);
    throw new UsageError(
      `Bundle ${JSON.stringify(bundle)} is not configured. Run \`akm bundle list\` to see available bundles.`,
      "INVALID_FLAG_VALUE",
    );
  }
  throw new NotFoundError(`Task asset ${makeBundleRef(bundle, conceptId)} was not found.`, "ASSET_NOT_FOUND");
}

/** Resolve, parse, and project one task-v3 asset into a frozen, executable projection. */
export async function loadPreparedTask(id: string, options: RunTaskOptions): Promise<PreparedTaskV3Execution> {
  const bundleDir = options.bundleDir;
  const adapterId = options.adapterId ?? detectAdapterId(bundleDir);
  if (adapterId === "akm-task") validateTaskConceptId(id);
  else validateTaskId(id);
  const taskConceptId = adapterId === "akm" ? `tasks/${id}` : id;
  const owner = resolveAdapterConceptOwner(bundleDir, adapterId, taskConceptId);
  if (!owner) {
    throw new NotFoundError(
      `Task ${JSON.stringify(id)} was not found in the configured ${JSON.stringify(adapterId)} component.`,
      "ASSET_NOT_FOUND",
    );
  }
  const filePath = owner.path;
  const yaml = fs.readFileSync(filePath, "utf8");
  const parsed = parseTaskSource({ yaml, filePath });
  const source = projectTaskSourceV4(parsed.v4);
  const requiresCommandConfig =
    source.target.kind === "uses" &&
    (source.target.uses.kind === "builtin-command" || source.target.uses.kind === "command");
  const config = requiresCommandConfig ? loadConfig() : CONFIG_FREE_TASK_RUNTIME;
  const bundleName = options.bundleName ?? config.defaultBundle ?? DEFAULT_BUNDLE_NAME;
  // Stage 2: materialize akm task run's raw input flags (Stage 1,
  // src/commands/tasks/tasks-cli.ts) against the task's own declared
  // inputs: contract (empty when the document declares none, so any input
  // flag on such a task fails UNKNOWN_FLAG — there is nothing declared to
  // match against).
  // materializeInputFlags already validates the flag-supplied values; a
  // required input satisfied only by its own default (never supplied as a
  // flag) needs the SEPARATE validateInputs call below, run after defaults
  // are applied — materializeInputFlags returns {} immediately for zero
  // flags, before ever checking `required` (input-contract.ts's own
  // header).
  const inputContract: InputContract = parsed.v4.inputs ?? {};
  const materializedInputs = materializeInputFlags(inputContract, options.inputFlags ?? [], TASK_INPUT_DIAGNOSTICS);
  const defaultedInputs = applyInputDefaults(inputContract, materializedInputs);
  const requiredErrors = validateInputs(inputContract, defaultedInputs);
  if (requiredErrors.length > 0) throw TASK_INPUT_DIAGNOSTICS.contractViolation(requiredErrors);
  const inputBindings: readonly TaskInputBinding[] = Object.entries(defaultedInputs).map(([name, value]) =>
    Object.freeze({ kind: "literal" as const, name, value }),
  );
  if (options.captureTaskInvocation) {
    const invocation: TaskInvocation = Object.freeze({
      taskRef: makeBundleRef(bundleName, taskConceptId),
      caller: Object.freeze({ kind: "cli" as const }),
      ...(inputBindings.length > 0 ? { inputs: Object.freeze(inputBindings) } : {}),
    });
    options.captureTaskInvocation(invocation);
  }
  // A task source v4 document's own declared `inputs:` deliver into a
  // `uses: workflows/<ref>` target's child-run params through the EXISTING
  // with-> params path (prepare.ts's workflow branch already reads
  // `document.target.with`) — task source v4 never authors `with:` on a
  // workflow target itself (task-source-v4.ts's own parser accepts `with:`
  // only on `uses: akm/command`), so this
  // override is purely additive for a workflow-target task.
  const deliverySource =
    source.target.kind === "uses" && source.target.uses.kind === "workflow"
      ? { ...source, target: { ...source.target, with: defaultedInputs as ExecutionJsonObject } }
      : source;
  return prepareTaskV3Execution(deliverySource, {
    taskId: id,
    taskRef: makeBundleRef(bundleName, taskConceptId),
    bundleName,
    bundleRoot: bundleDir,
    config,
    // Agent profiles build child env from an allowlist, so freeze the closed
    // AKM directory context the scheduled row set before command preparation.
    ...(options.scheduled ? { schedulerContext: scheduledTaskContextEnv() } : {}),
    resolveAsset: async ({ bundle, type, name }) => {
      if (bundle === bundleName) {
        return { file: await resolveAssetPath(bundleDir, type, name), bundleRoot: bundleDir };
      }
      return resolveBundleAsset(requiresCommandConfig ? config : loadConfig(), { bundle, type, name });
    },
  });
}
