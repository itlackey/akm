// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The remaining `surfaces` advisory group for `akm health` (meta-review 08).
 * `stash-git-exposure` (08-F1) shipped first in ./stash-exposure.ts; this
 * module adds the other four read-only checks the adjudication approved:
 *
 *   - `secret-file-perms`   — env/secret/backup files not 0600, dirs not 0700 (F4)
 *   - `binary-config-skew`  — config.json written by a NEWER akm than this binary (F3)
 *   - `orphan-stores`       — legacy config-backups dirs + 0-byte stash state.db decoy (F4/F7)
 *   - `egress-endpoints`    — the remote-destination list, for eyeball diff (surfaces 3/9)
 *
 * Every collector is a pure projection over injected paths/config (no
 * process.env reads) and is silent when there is nothing to report, matching
 * the stash-exposure pattern. `egress-endpoints` is the one informational
 * (pass-status) entry: it emits whenever any remote endpoint is configured.
 */

import fs from "node:fs";
import path from "node:path";
import { MAX_CONFIG_FILE_BYTES, readTextFileWithLimit } from "../../core/common";
import { CURRENT_CONFIG_VERSION } from "../../core/config/config-schema";
import { compareConfigVersion } from "../../core/config/config-version";
import type { HealthCheckResult } from "./types";

/** POSIX permission checks are meaningless on Windows. */
type PlatformLike = NodeJS.Platform | string;

const GROUP_OTHER_BITS = 0o077;
const OFFENDER_EVIDENCE_CAP = 50;

function modeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * `secret-file-perms` (08-F4): flag env/secret/backup files that are not 0600
 * and their directories when not 0700. Scans `<stash>/env`, `<stash>/secrets`
 * and `<cache>/config-backups`; anything readable by group/other is an
 * offender. Silent when every path is tight (or none of the dirs exist).
 */
export function collectSecretPermsAdvisory(
  input: { stashDir: string; cacheDir: string },
  platform: PlatformLike = process.platform,
): HealthCheckResult | undefined {
  if (platform === "win32") return undefined;

  const roots = [
    path.join(input.stashDir, "env"),
    path.join(input.stashDir, "secrets"),
    path.join(input.cacheDir, "config-backups"),
  ];
  const offenders: string[] = [];

  for (const root of roots) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      continue; // absent → nothing to protect
    }
    if ((stat.mode & GROUP_OTHER_BITS) !== 0) offenders.push(`${root}/ (${modeOctal(stat.mode)}, want 700)`);
    let entries: string[];
    try {
      entries = fs.readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(root, entry);
      let entryStat: fs.Stats;
      try {
        entryStat = fs.statSync(abs);
      } catch {
        continue;
      }
      if ((entryStat.mode & GROUP_OTHER_BITS) === 0) continue;
      offenders.push(
        entryStat.isDirectory()
          ? `${abs}/ (${modeOctal(entryStat.mode)}, want 700)`
          : `${abs} (${modeOctal(entryStat.mode)}, want 600)`,
      );
    }
  }

  if (offenders.length === 0) return undefined;
  const preview = offenders.slice(0, 5).join("; ") + (offenders.length > 5 ? `; +${offenders.length - 5} more` : "");
  return {
    name: "secret-file-perms",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${offenders.length} env/secret/backup path(s) are readable by group/other: ${preview}. ` +
      "Tighten with chmod 600 (files) / chmod 700 (dirs) — these hold tokens, keys, and config snapshots.",
    evidence: { offenders: offenders.slice(0, OFFENDER_EVIDENCE_CAP) },
  };
}

/**
 * `binary-config-skew` (08-F3): warn when config.json carries a configVersion
 * NEWER than (or unorderable against) this binary's CURRENT_CONFIG_VERSION —
 * i.e. a newer/foreign akm wrote the shared config and this install is stale.
 * That is exactly the state where auto-migration is skipped (downgrade
 * protection) and the proven multi-install incident class begins. Silent for
 * same/older versions (auto-migration handles those) and unreadable configs
 * (config loading surfaces its own errors).
 */
export function collectConfigSkewAdvisory(configPath: string): HealthCheckResult | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
  const onDisk = raw.configVersion as string | number | undefined;
  const order = compareConfigVersion(onDisk, CURRENT_CONFIG_VERSION);
  const skewed = order === 1 || (onDisk !== undefined && order === undefined);
  if (!skewed) return undefined;
  return {
    name: "binary-config-skew",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `config.json has configVersion ${JSON.stringify(onDisk)} but this binary knows ${CURRENT_CONFIG_VERSION} — ` +
      "a newer akm wrote the shared config, so this install is stale and auto-migration is skipped " +
      "(downgrade protection). Upgrade this install; do not keep a stale binary against the shared config/DBs.",
    evidence: { onDiskConfigVersion: onDisk, binaryConfigVersion: CURRENT_CONFIG_VERSION },
  };
}

/**
 * `orphan-stores` (08-F4/F7): stores that look load-bearing but are dead —
 * legacy `config-backups/` dirs in $DATA/$CONFIG (only `$CACHE/config-backups`
 * is written and pruned today) and a 0-byte `<stash>/.akm/state.db` decoy that
 * misleads debugging (the live state.db lives in the data dir). Read-only:
 * this advisory NAMES them; removal stays an owner-approved per-path action.
 */
export function collectOrphanStoresAdvisory(input: {
  dataDir: string;
  configDir: string;
  stashDir: string;
}): HealthCheckResult | undefined {
  const orphans: string[] = [];

  for (const [label, dir] of [
    ["legacy data-dir backup location", path.join(input.dataDir, "config-backups")],
    ["legacy config-dir backup location", path.join(input.configDir, "config-backups")],
  ] as const) {
    try {
      if (fs.statSync(dir).isDirectory()) orphans.push(`${dir}/ (${label}; live backups are in $CACHE/config-backups)`);
    } catch {
      // absent — fine
    }
  }

  const decoy = path.join(input.stashDir, ".akm", "state.db");
  try {
    const stat = fs.statSync(decoy);
    if (stat.isFile() && stat.size === 0) {
      orphans.push(`${decoy} (0-byte decoy; the live state.db is in the data dir)`);
    }
  } catch {
    // absent — fine
  }

  if (orphans.length === 0) return undefined;
  return {
    name: "orphan-stores",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${orphans.length} orphan store(s) found: ${orphans.join("; ")}. ` +
      "These are dead locations that mislead debugging/recovery — review and remove them (owner-approved, per-path).",
    evidence: { orphans },
  };
}

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
    endpoints.push(`registry ${reg.name ?? "(unnamed)"}: ${reg.url}`);
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

/**
 * Aggregate the four collectors into the advisories array shape `akmHealth`
 * consumes. Order is fixed: perms → skew → orphans → egress.
 */
export function collectSurfacesAdvisories(input: {
  stashDir: string;
  cacheDir: string;
  dataDir: string;
  configDir: string;
  configPath: string;
  config: EgressConfigView | undefined;
  platform?: PlatformLike;
}): HealthCheckResult[] {
  const results = [
    collectSecretPermsAdvisory(
      { stashDir: input.stashDir, cacheDir: input.cacheDir },
      input.platform ?? process.platform,
    ),
    collectConfigSkewAdvisory(input.configPath),
    collectOrphanStoresAdvisory({ dataDir: input.dataDir, configDir: input.configDir, stashDir: input.stashDir }),
    collectEgressAdvisory(input.config),
  ];
  return results.filter((r): r is HealthCheckResult => r !== undefined);
}
