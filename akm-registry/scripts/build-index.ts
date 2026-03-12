#!/usr/bin/env bun
/**
 * Build script for generating the akm registry index (v2).
 *
 * Reads manual-entries.json (curated kits with optional asset-level metadata)
 * and emits a v2 registry index to stdout.
 *
 * Usage:
 *   bun run akm-registry/scripts/build-index.ts > index.json
 *   bun run akm-registry/scripts/build-index.ts --out akm-registry/index.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ManualAsset {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
}

interface ManualEntry {
  id: string;
  name: string;
  description?: string;
  ref: string;
  source: "npm" | "github" | "git" | "local";
  homepage?: string;
  tags?: string[];
  assetTypes?: string[];
  assets?: ManualAsset[];
  author?: string;
  license?: string;
  latestVersion?: string;
  curated?: boolean;
}

interface RegistryIndex {
  version: number;
  updatedAt: string;
  kits: ManualEntry[];
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const manualEntriesPath = path.resolve(scriptDir, "..", "manual-entries.json");

function loadManualEntries(): ManualEntry[] {
  if (!fs.existsSync(manualEntriesPath)) {
    console.error(`No manual-entries.json found at ${manualEntriesPath}`);
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(manualEntriesPath, "utf8"));
  if (!Array.isArray(raw)) {
    console.error("manual-entries.json must be a JSON array");
    return [];
  }
  return raw as ManualEntry[];
}

function buildIndex(): RegistryIndex {
  const entries = loadManualEntries();
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    kits: entries.map((entry) => ({
      ...entry,
      curated: entry.curated ?? true,
    })),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

const index = buildIndex();
const json = JSON.stringify(index, null, 2);

const outFlag = process.argv.indexOf("--out");
if (outFlag !== -1 && process.argv[outFlag + 1]) {
  const outPath = path.resolve(process.argv[outFlag + 1]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${json}\n`, "utf8");
  console.error(`Wrote ${index.kits.length} kits to ${outPath}`);
} else {
  console.log(json);
}
