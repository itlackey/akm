// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { loadAdapterExecutionSource } from "../../commands/command/execution-source-loader";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { compareCodePoints, isWithin, toPosix } from "../../core/common";
import type { AkmConfig } from "../../core/config/config-types";
import { parseEnvRef } from "../../core/env-secret-ref";
import { UsageError } from "../../core/errors";
import { deriveInstallations } from "../../indexer/installations";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveAssetPath } from "../../sources/resolve";
import { isInferredSecretName } from "../../tasks/log-redaction";
import { SECRET_TOKEN_RE } from "../exec/environment";
import { detectSecretShapedParams } from "../exec/param-secrets";
import type { FrozenWorkflowEnvironmentBinding, WorkflowExec } from "../plan";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import type { FreezeStep, OwnedAsset, ResolutionContext } from "./step-values";

/**
 * A step's frozen environment: literal `env:` values, `pass_env` names, then
 * one value-free descriptor per `unit.env` ref (owner, key set, secret-token
 * names). Values are read at dispatch (`exec/environment.ts`), never frozen.
 */
export function freezeEnvironment(
  source: FreezeStep,
  exec: WorkflowExec | undefined,
  context: ResolutionContext,
): FrozenWorkflowEnvironmentBinding[] {
  const literals = Object.entries(source.env ?? {}).map(([name, raw]) => {
    const value = String(raw);
    // A literal is frozen into plan_json; a credential belongs in an env ref, as for task env.
    if (isInferredSecretName(name) || detectSecretShapedParams({ [name]: value }).length > 0) {
      throw new UsageError(
        `Workflow step ${source.id} env.${name} is a secret-shaped literal env value. Store credentials in an env asset (unit.env) rather than workflow source.`,
        "WORKFLOW_SOURCE_INVALID",
      );
    }
    return Object.freeze({ kind: "literal" as const, name, value });
  });
  const passThrough = (exec?.passEnv ?? []).map((name) => Object.freeze({ kind: "pass-through" as const, name }));
  const seen = new Set<string>();
  const envRefs: FrozenWorkflowEnvironmentBinding[] = [];
  for (const [precedence, ref] of (source.unit?.env ?? []).entries()) {
    if (parseEnvRef(ref).type !== "env") {
      throw new UsageError(`Expected an env ref; got ${ref}.`, "WORKFLOW_SOURCE_INVALID");
    }
    const owned = resolveOwnedAssetSync(ref, "env", context);
    if (seen.has(owned.ref)) continue;
    seen.add(owned.ref);
    const parsed = dotenv.parse(fs.readFileSync(owned.file));
    const secretNames = new Set<string>();
    for (const value of Object.values(parsed)) {
      for (const match of value.matchAll(SECRET_TOKEN_RE)) if (match[1]) secretNames.add(match[1]);
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
  return [...literals, ...passThrough, ...envRefs];
}

/** Load a command or persona the workflow names, resolved through the workflow's own bundles. */
export async function workflowExecutionSource(ref: string, kind: "command" | "persona", context: ResolutionContext) {
  const owned = await resolveOwnedAsset(ref, kind === "command" ? "command" : "agent", context);
  return kind === "command"
    ? loadAdapterExecutionSource(owned.ref, "command", { config: context.config })
    : loadAdapterExecutionSource(owned.ref, "persona", { config: context.config });
}

export async function resolveOwnedAsset(
  ref: string,
  type: "command" | "agent" | "task" | "workflow" | "script" | "env",
  context: ResolutionContext,
): Promise<OwnedAsset> {
  return resolveOwnedAssetCore(ref, type, context, false) as Promise<OwnedAsset>;
}

export function resolveOwnedAssetSync(ref: string, type: "env", context: ResolutionContext): OwnedAsset {
  return resolveOwnedAssetCore(ref, type, context, true) as OwnedAsset;
}

function resolveOwnedAssetCore(
  refInput: string,
  type: "command" | "agent" | "task" | "workflow" | "script" | "env",
  context: ResolutionContext,
  sync: boolean,
): OwnedAsset | Promise<OwnedAsset> {
  const parsed = parseBundleRef(refInput);
  const plural = type === "env" ? "env" : `${type}s`;
  const conceptId = parsed.conceptId.startsWith(`${plural}/`) ? parsed.conceptId : `${plural}/${parsed.conceptId}`;
  const name = conceptId.slice(plural.length + 1);
  const direct = parsed.bundle ? configuredOwner(parsed.bundle, context.config) : undefined;
  const candidates = direct ? [direct] : installedOwners(parsed.bundle, context.config);
  const findSync = (): OwnedAsset => {
    for (const candidate of candidates) {
      const directory = path.join(candidate.root, plural);
      for (const extension of assetExtensions(type)) {
        const file = path.resolve(directory, `${name}${extension}`);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          if (!isWithin(file, candidate.root)) {
            throw new UsageError(`${file} resolves outside its owning root.`, "PATH_ESCAPE_VIOLATION");
          }
          return { ...candidate, ref: makeBundleRef(candidate.bundle, conceptId), file };
        }
      }
    }
    throw new UsageError(`Workflow source target ${refInput} was not found.`, "INVALID_FLAG_VALUE");
  };
  if (sync) return findSync();
  return (async () => {
    for (const candidate of candidates) {
      try {
        const file = await resolveAssetPath(candidate.root, type, name);
        return { ...candidate, ref: makeBundleRef(candidate.bundle, conceptId), file };
      } catch {
        // Continue in installation priority order.
      }
    }
    return findSync();
  })();
}

/** Every installed bundle root (or just `bundle`'s), in installation priority order. */
function installedOwners(
  bundle: string | undefined,
  config: AkmConfig,
): Array<{ bundle: string; root: string; adapter: string }> {
  const sources = resolveSourceEntries(undefined, config);
  const installations = deriveInstallations(sources);
  return sources.flatMap((source, index) => {
    const installation = installations[index];
    if (!installation || (bundle && installation.id !== bundle)) return [];
    return [
      {
        bundle: installation.id,
        root: source.path,
        adapter: source.adapterId ?? installation.components[0]?.adapter ?? "akm",
      },
    ];
  });
}

function configuredOwner(
  bundle: string,
  config: AkmConfig,
): { bundle: string; root: string; adapter: string } | undefined {
  const entry = config.bundles?.[bundle];
  if (!entry || typeof entry.path !== "string") return undefined;
  const components = entry.components ? Object.values(entry.components) : [];
  const component = components[0];
  return {
    bundle,
    root: path.resolve(entry.path, component?.root ?? "."),
    adapter: component?.adapter ?? "akm",
  };
}

const SCRIPT_EXTENSIONS = [
  "",
  ".sh",
  ".ts",
  ".js",
  ".py",
  ".rb",
  ".go",
  ".pl",
  ".php",
  ".lua",
  ".r",
  ".swift",
  ".kt",
  ".kts",
  ".ps1",
  ".cmd",
  ".bat",
];

function assetExtensions(type: string): readonly string[] {
  if (type === "script") return SCRIPT_EXTENSIONS;
  if (type === "env") return ["", ".env"];
  return ["", ".md", ".yml"];
}

export function qualifyRef(ref: string, plural: string, asset: WorkflowAsset, config: AkmConfig): string {
  const parsed = parseBundleRef(ref);
  if (parsed.bundle) return ref;
  const bundle = parseBundleRef(asset.ref).bundle ?? config.defaultBundle;
  if (!bundle) throw new UsageError(`Workflow ref ${ref} has no owning bundle.`, "WORKFLOW_SOURCE_INVALID");
  const concept = parsed.conceptId.startsWith(`${plural}/`) ? parsed.conceptId : `${plural}/${parsed.conceptId}`;
  return makeBundleRef(bundle, concept);
}
