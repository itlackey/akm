// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental` config section — explicit opt-ins for behaviour that is not
 * covered by the stability contract (D8).
 *
 * An entry here exists so a user can turn something ON deliberately. Every key
 * defaults to OFF, and the runtime must treat "absent" and "false" identically:
 * autonomy is never inferred from a partially-written config.
 */
import { z } from "zod";
import { ImproveWhereSchema } from "./improve";
import { ImproveProfileConfigSchema } from "./improve-processes";
import { engineName, httpUrl, isApiKeyReference } from "./primitives";

/** An http(s) origin: scheme, host and optional port, with no credentials, path, query or fragment. */
function isHttpOrigin(value: string): boolean {
  if (/[?#@]/.test(value)) return false;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.pathname === "/" && !/^https?:\/\/[^/]+\/./.test(value);
  } catch {
    return false;
  }
}
const httpOrigin = httpUrl.refine(isHttpOrigin, {
  message: "must be an http(s) origin such as https://host[:port], with no path, query or fragment",
});

export const ExperimentalConfigSchema = z
  .object({
    /**
     * Allow `akm improve` to mutate assets without review.
     *
     * OFF by default. Gates memory-cleanup, memory-inference writes, and triage
     * `applyMode: "promote"`. Consolidation stays enabled because destructive
     * operations are advisory and promotion emits a reviewable proposal.
     * `akm improve` itself stays on either way — what this gates is autonomy,
     * not the feature.
     *
     * `sync.push` is deliberately NOT gated by this key: it publishes
     * already-committed content to a remote the user configured for that
     * purpose, and it has its own `sync.push: false` / `--no-push` controls.
     */
    improveAutonomy: z.boolean().optional(),
    /**
     * Allow `akm exec`: any command, run with env assets and secrets injected.
     *
     * OFF by default. `akm run --env/--secret`, which injects into an akm asset's run, is not gated.
     */
    exec: z.boolean().optional(),
    /**
     * The research learning controls, under the paths `improve.*` has for them. `strategies` is
     * `improve.strategies` (custom strategies, process `enabled`, `allowedTypes`, quality-gate toggles, reflect
     * `defectFilter`, extract triage and session indexing, triage `applyMode` and `judgment`, the CLS knobs and the
     * rest of a strategy); `qualityGate` is `improve.qualityGate` (where the judge runs). Each reads as the same key
     * under `improve`; when both are set to different values this one wins, with a warning.
     */
    learning: z
      .object({
        strategies: z.record(engineName, ImproveProfileConfigSchema).optional(),
        qualityGate: ImproveWhereSchema.optional(),
      })
      .passthrough()
      .optional(),
    /**
     * Settings for `akm-web` (AKM Desktop's server). Experimental: names and behaviour may change in 0.11.
     * `secret` is a reference (`$VAR`, `${VAR}` or `${secrets/<name>}`), never the secret itself.
     */
    web: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(0).max(65535).optional(),
        origin: httpOrigin.optional(),
        secret: z
          .string()
          .refine(isApiKeyReference, { message: "secret must be a $VAR, ${VAR} or ${secrets/<name>} reference" })
          .optional(),
        allowedHosts: z.array(z.string().min(1)).optional(),
        frameParents: z.array(httpOrigin).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
