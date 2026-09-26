// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `egress-endpoints` advisory for `akm health` (meta-review 08, surfaces 3/9):
 * the remote-destination list, for eyeball diff. A pure projection over the
 * effective config (no process.env reads); silent when nothing remote is
 * configured, matching the `stash-git-exposure` / `binary-config-skew`
 * advisories' pattern.
 */

import { formatRegistryUrl } from "../../core/registry-url";
import type { HealthCheckResult } from "./types";

/**
 * Minimal structural view of the effective config for the egress list —
 * deliberately not the full AkmConfig type so tests stay decoupled and the
 * collector never needs config loading itself.
 */
export interface EgressConfigView {
  registries?: Array<{ url?: string; name?: string; enabled?: boolean }>;
  // 0.9.0 (spec §10.1): remote source URLs come from the `bundles` map's git /
  // website descriptors, not the retired `sources[]`.
  bundles?: Record<string, { path?: string; git?: string; website?: { url?: string }; npm?: string } | undefined>;
  engines?: Record<string, { kind?: string; endpoint?: string } | undefined>;
  embedding?: { endpoint?: string };
}

/**
 * `egress-endpoints` (08 surfaces 3/9): the full list of remote destinations
 * akm can talk to under the effective config — registries, remote sources,
 * LLM endpoints, embedding endpoint — as one pass-status informational entry
 * for eyeball diff against expectations. Silent only when nothing remote is
 * configured at all.
 */
export function collectEgressAdvisory(config: EgressConfigView | undefined): HealthCheckResult | undefined {
  if (!config) return undefined;
  const endpoints: string[] = [];

  for (const reg of config.registries ?? []) {
    if (reg.enabled === false || !reg.url) continue;
    endpoints.push(`registry ${reg.name ?? "(unnamed)"}: ${formatRegistryUrl(reg.url)}`);
  }
  for (const [key, bundle] of Object.entries(config.bundles ?? {})) {
    if (!bundle) continue;
    const url = bundle.git ?? bundle.website?.url;
    if (!url) continue;
    endpoints.push(`source ${key} (${bundle.git ? "git" : "website"}): ${url}`);
  }
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine?.kind !== "llm" || !engine.endpoint) continue;
    endpoints.push(`llm ${name}: ${engine.endpoint}`);
  }
  if (config.embedding?.endpoint) endpoints.push(`embedding: ${config.embedding.endpoint}`);

  if (endpoints.length === 0) return undefined;
  return {
    name: "egress-endpoints",
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message:
      `${endpoints.length} remote endpoint(s) in the effective config (registries/sources/LLM/embedding) — ` +
      "review the evidence list for unexpected destinations.",
    evidence: { endpoints },
  };
}
