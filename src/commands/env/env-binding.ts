// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Env-ref → resolved values, shared between `akm env run` and the workflow
 * engine's per-unit env bindings (orchestration plan, *Dispatch context*).
 *
 * Extracted from `env-cli.ts`'s `runEnvInjected` so the native executor
 * REUSES the exact same machinery instead of forking it. Every safety
 * invariant carries over unchanged:
 *
 *   - `${secret:NAME}` tokens resolve against the env's own stash; a missing
 *     secret is a hard error and NOTHING is injected (no partial injection).
 *   - Known process-hijacking keys (LD_PRELOAD, PATH, …) are blocked for
 *     third-party-sourced stashes and warned about for first-party ones.
 *   - An `env_access` audit event records key NAMES only, never values.
 *   - Resolved values must never be written to stdout or logs by callers.
 */

import fs from "node:fs";
import path from "node:path";
import { decideDangerousEnvInjection } from "../../core/activation-policy";
import { assetPathForName } from "../../core/asset/asset-placement";
import { isWithin } from "../../core/common";
import { makeEnvRef, makeSecretRef, resolveEnvPath } from "../../core/env-secret-ref";
import { NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { isDangerousEnvKey } from "../lint/env-key-rules";
import { loadEnv, resolveSecretTokens } from "./env";
import { readValue } from "./secret";

export interface ResolvedEnvBinding {
  /** Canonical env ref (with origin when the source has one). */
  ref: string;
  /** Resolved KEY=value map. NEVER print values. */
  values: Record<string, string>;
  /** Key names, safe to log/audit. */
  keys: string[];
}

export interface ResolveEnvBindingOptions {
  /** Inject ONLY these keys. Mutually exclusive with `except`. */
  only?: string[];
  /** Inject all keys EXCEPT these. */
  except?: string[];
  /** Callback for non-fatal warnings (defaults to stderr). */
  warn?: (message: string) => void;
}

/**
 * Resolve an env ref to its injectable values: load the file, apply key
 * filtering, substitute `${secret:NAME}` tokens from the sibling secrets
 * directory, enforce the dangerous-key policy, and append the keys-only
 * `env_access` audit event.
 */
export function resolveEnvBinding(target: string, options: ResolveEnvBindingOptions = {}): ResolvedEnvBinding {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`warning: ${message}\n`));
  const { name, absPath, source } = resolveEnvPath(target);
  const envRef = makeEnvRef(name, source);
  if (!fs.existsSync(absPath)) {
    throw new NotFoundError(`Env not found: ${envRef}`);
  }

  const allValues = loadEnv(absPath);

  // Value-safe key filtering (--only / --except operate on key NAMES only).
  let envValues = allValues;
  if (options.only && options.except) {
    throw new UsageError("Pass only one of --only or --except.", "INVALID_FLAG_VALUE");
  }
  if (options.only) {
    const wanted = new Set(options.only);
    const missing = options.only.filter((k) => !(k in allValues));
    if (missing.length > 0) {
      warn(`--only key(s) not present in ${envRef}: ${missing.join(", ")}`);
    }
    envValues = Object.fromEntries(Object.entries(allValues).filter(([k]) => wanted.has(k)));
  } else if (options.except) {
    const excluded = new Set(options.except);
    envValues = Object.fromEntries(Object.entries(allValues).filter(([k]) => !excluded.has(k)));
  }

  // Substitute `${secret:NAME}` tokens with the sibling secret asset in the
  // SAME stash. A missing secret is a hard error — inject NOTHING.
  const secretsRoot = path.join(source.path, "secrets");
  const resolveSecret = (secretName: string): string | undefined => {
    const secretPath = assetPathForName("secret", secretsRoot, secretName);
    // Defense-in-depth: ensure the resolved path stays inside the secrets dir.
    if (!isWithin(secretPath, secretsRoot)) {
      throw new UsageError(`Secret name "${secretName}" escapes the secrets directory.`);
    }
    if (!fs.existsSync(secretPath)) return undefined;
    // Match `secret run`: read utf8, do not trim (stay consistent with that path).
    return readValue(secretPath).toString("utf8");
  };
  const { values: substituted, missing } = resolveSecretTokens(envValues, resolveSecret);
  if (missing.length > 0) {
    throw new NotFoundError(
      `Env "${envRef}" references secret(s) not found in its stash: ${missing.map((n) => makeSecretRef(n)).join(", ")}. Nothing was injected.`,
      "FILE_NOT_FOUND",
      `Create the missing secret, e.g. \`akm secret set ${makeSecretRef(missing[0])}\`.`,
    );
  }
  envValues = substituted;
  const keys = Object.keys(envValues);

  // Scan injected keys for known process-hijacking variables. The workspace
  // activation policy decides block (third-party, registryId set) vs. warn
  // (first-party stash, where the operator owns the file).
  const dangerous = keys.filter(isDangerousEnvKey);
  if (dangerous.length > 0) {
    const detail = `Env "${envRef}" injects process-hijacking variable(s): ${dangerous.join(", ")}.`;
    const decision = decideDangerousEnvInjection({ dangerousKeys: dangerous, thirdParty: Boolean(source.registryId) });
    if (decision === "block") {
      throw new UsageError(
        `Refusing to inject env from a third-party stash. ${detail}\n` +
          `       Review the file, then copy the values into a first-party env if you trust them.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (decision === "warn") {
      warn(`${detail} Injecting anyway (first-party stash).`);
    }
  }

  // Audit trail: keys only, never values.
  appendEvent({ eventType: "env_access", ref: envRef, metadata: { keys } });

  return { ref: envRef, values: envValues, keys };
}
