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
 *   - `${ref}` tokens resolve through the one ref walk (a `secrets/` ref to the
 *     secret's trimmed value, any other asset ref to its absolute path); a
 *     missing ref is a hard error and NOTHING is injected (no partial injection).
 *   - An `env_access` audit event records key NAMES only, never values.
 *   - Resolved values must never be written to stdout or logs by callers.
 */

import { makeEnvRef, resolveEnvPath, resolveRefOwner } from "../../core/env-secret-ref";
import { NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { substituteRefTokens } from "../../core/ref-token";
import { loadEnv } from "./env";
import { readValue } from "./secret";

export interface ResolvedEnvBinding {
  /** Canonical env ref (with origin when the source has one). */
  ref: string;
  /** Resolved KEY=value map. NEVER print values. */
  values: Record<string, string>;
  /** Key names, safe to log/audit. */
  keys: string[];
  /** Every value substituted from a `secrets/` ref, for redaction. Configuration values are not listed. */
  secretValues: string[];
}

/**
 * What a `${ref}` token stands for: a `secrets/` ref yields the secret's
 * trimmed value, any other asset ref its absolute path, a ref no bundle owns
 * `undefined`. The one resolver behind env values and exec argv.
 */
export function resolveRefToken(
  ref: string,
): { kind: "secret"; value: string } | { kind: "path"; path: string } | undefined {
  const owner = resolveRefOwner(ref);
  if (owner === undefined) return undefined;
  return owner.type === "secret"
    ? { kind: "secret", value: readValue(owner.absPath) }
    : { kind: "path", path: owner.absPath };
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
 * filtering, substitute `${ref}` tokens, and append the keys-only
 * `env_access` audit event.
 */
export function resolveEnvBinding(target: string, options: ResolveEnvBindingOptions = {}): ResolvedEnvBinding {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`warning: ${message}\n`));
  const { name, absPath, source } = resolveEnvPath(target);
  const envRef = makeEnvRef(name, source);

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

  // Substitute `${ref}` tokens. A missing ref is a hard error — inject NOTHING.
  const { values: substituted, missing, secretValues } = substituteRefTokens(envValues, resolveRefToken);
  if (missing.length > 0) {
    throw new NotFoundError(
      `Env "${envRef}" references asset(s) that no bundle owns: ${missing.join(", ")}. Nothing was injected.`,
      "FILE_NOT_FOUND",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${ref}` token syntax documented for users, not interpolation
      "Write each `${ref}` as a full akm ref that exists, e.g. `${secrets/name}` or `${team//scripts/run.sh}`.",
    );
  }
  envValues = substituted;
  const keys = Object.keys(envValues);

  // Audit trail: keys only, never values.
  appendEvent({ eventType: "env_access", ref: envRef, metadata: { keys } });

  return { ref: envRef, values: envValues, keys, secretValues };
}
