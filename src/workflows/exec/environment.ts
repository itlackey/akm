// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Materialize a unit's frozen environment at dispatch. Env-file values are the
 * one deliberately live input to a frozen plan: freeze records each ref's
 * owner, key set and `${secret:…}` names; the values (and the secrets they
 * name) are read here, per dispatch, and nothing is returned until every read
 * has succeeded.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { assetPathForName } from "../../core/asset/asset-placement";
import { compareCodePoints, isWithin } from "../../core/common";
import { NotFoundError, UsageError } from "../../core/errors";
import type { FrozenWorkflowEnvironmentBinding, FrozenWorkflowEnvironmentOwner } from "../plan";

export const SECRET_TOKEN_RE = /\$\{secret:([A-Za-z0-9_./-]+)\}/g;

type EnvRefBinding = Extract<FrozenWorkflowEnvironmentBinding, { kind: "env-ref" }>;

export interface MaterializeFrozenWorkflowEnvironmentOptions {
  readonly readEnvFile?: (descriptor: EnvRefBinding) => string | Uint8Array;
  readonly readSecret?: (input: {
    readonly name: string;
    readonly descriptor: EnvRefBinding;
  }) => string | Uint8Array | undefined;
  readonly readPassThrough?: (name: string) => string | undefined;
}

export interface MaterializedFrozenWorkflowEnvironment {
  readonly values: Record<string, string>;
  readonly sensitiveValues: string[];
  readonly audits: { eventType: "env_access"; ref: string; keys: readonly string[]; secretNames: readonly string[] }[];
}

export function materializeFrozenWorkflowEnvironment(
  descriptors: readonly FrozenWorkflowEnvironmentBinding[],
  options: MaterializeFrozenWorkflowEnvironmentOptions = {},
): MaterializedFrozenWorkflowEnvironment {
  const values: Record<string, string> = {};
  const sensitive = new Set<string>();
  const audits: MaterializedFrozenWorkflowEnvironment["audits"] = [];

  for (const descriptor of descriptors) {
    if (descriptor.kind === "literal") {
      values[descriptor.name] = descriptor.value;
      if (descriptor.value) sensitive.add(descriptor.value);
      continue;
    }
    if (descriptor.kind === "pass-through") {
      const value = options.readPassThrough ? options.readPassThrough(descriptor.name) : process.env[descriptor.name];
      if (value !== undefined) {
        values[descriptor.name] = value;
        if (value) sensitive.add(value);
      }
      continue;
    }
    const source = options.readEnvFile ? options.readEnvFile(descriptor) : readEnvFile(descriptor.owner);
    const parsed = dotenv.parse(typeof source === "string" ? source : Buffer.from(source));
    const keys = Object.keys(parsed).sort(compareCodePoints);
    if (!sameStrings(keys, descriptor.keys))
      invalid(`environment ${descriptor.ref} key set changed after it was frozen`);
    const secretValues = new Map<string, string>();
    for (const name of descriptor.secretNames) {
      const raw = options.readSecret ? options.readSecret({ name, descriptor }) : readSecret(descriptor.owner, name);
      if (raw === undefined) {
        throw new NotFoundError(
          `Environment ${descriptor.ref} references missing secret ${name}; nothing was materialized.`,
          "FILE_NOT_FOUND",
        );
      }
      const value = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
      secretValues.set(name, value);
      if (value) sensitive.add(value);
    }
    for (const [key, rawValue] of Object.entries(parsed)) {
      const resolved = rawValue.replace(SECRET_TOKEN_RE, (_token, name: string) => {
        const secret = secretValues.get(name);
        if (secret === undefined) invalid(`environment ${descriptor.ref} secret ${name} was not frozen`);
        return secret;
      });
      values[key] = resolved;
      if (resolved) sensitive.add(resolved);
    }
    audits.push({
      eventType: "env_access",
      ref: descriptor.ref,
      keys: [...descriptor.keys],
      secretNames: [...descriptor.secretNames],
    });
  }
  return { values, sensitiveValues: [...sensitive], audits };
}

function readEnvFile(owner: FrozenWorkflowEnvironmentOwner): Uint8Array {
  if (!isWithin(owner.requestedPath, owner.requestedRoot)) invalid(`env file ${owner.relativePath} escapes its bundle`);
  return fs.readFileSync(owner.requestedPath);
}

function readSecret(owner: FrozenWorkflowEnvironmentOwner, name: string): Uint8Array | undefined {
  const secretsRoot = path.join(owner.requestedRoot, "secrets");
  const secretPath = assetPathForName("secret", secretsRoot, name);
  if (!isWithin(secretPath, secretsRoot)) invalid(`secret name ${name} escapes its bundle`);
  try {
    return fs.readFileSync(secretPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(message: string): never {
  throw new UsageError(`Invalid frozen workflow environment: ${message}.`, "WORKFLOW_SOURCE_INVALID");
}
