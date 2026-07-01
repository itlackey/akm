#!/usr/bin/env bun
/**
 * Generate schemas/akm-config.json from the canonical Zod schema in
 * src/core/config/config-schema.ts. Run after editing the schema (or wire as a
 * pre-build step) so the published JSON Schema never drifts.
 *
 * Usage:
 *   bun scripts/gen-config-schema.ts          # write schemas/akm-config.json
 *   bun scripts/gen-config-schema.ts --check  # exit non-zero if the file is stale
 */
import fs from "node:fs";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AkmConfigSchema,
  EmbeddingConnectionConfigSchema,
  ImproveProcessConfigSchema,
  ImproveProfileConfigSchema,
  LlmProfileConfigSchema,
  RegistryConfigEntrySchema,
  SourceConfigEntrySchema,
} from "../src/core/config/config-schema";

interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  $defs?: Record<string, unknown>;
  [key: string]: unknown;
}

function generate(): JsonSchema {
  // Top-level schema with $defs for the named sub-schemas the drift test pins.
  // We generate each named sub-schema with its own name + target, then merge
  // them into a single $defs map.
  const targets = {
    AkmConfig: AkmConfigSchema,
    LlmProfileConfig: LlmProfileConfigSchema,
    EmbeddingConnectionConfig: EmbeddingConnectionConfigSchema,
    ImproveProcessConfig: ImproveProcessConfigSchema,
    ImproveProfileConfig: ImproveProfileConfigSchema,
    RegistryConfigEntry: RegistryConfigEntrySchema,
    StashConfigEntry: SourceConfigEntrySchema,
  } as const;

  const defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(targets)) {
    const partial = zodToJsonSchema(schema, {
      name,
      $refStrategy: "none",
      definitions: {},
    }) as Record<string, unknown>;
    // zod-to-json-schema (with `name`) returns `{ $ref: "#/definitions/<name>", definitions: { <name>: {...} } }`.
    // We unwrap to the inner schema object.
    const definitions = partial.definitions as Record<string, unknown> | undefined;
    if (definitions && definitions[name]) {
      defs[name] = definitions[name];
    } else {
      defs[name] = partial;
    }
  }

  const top = defs.AkmConfig as Record<string, unknown>;

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://itlackey.github.io/akm/schemas/akm-config.0.8.0.json",
    title: "AKM Configuration",
    description:
      "Configuration file for the akm CLI (Agent Knowledge Management). Stored at " +
      "~/.config/akm/config.json (Linux/macOS) or %APPDATA%\\akm\\config.json " +
      "(Windows). Supports JSONC (JavaScript-style comments). Auto-generated " +
      "from src/core/config-schema.ts by scripts/gen-config-schema.ts — do NOT edit by hand.",
    ...top,
    $defs: defs,
  };
}

/**
 * Compare the generated schema against the committed schemas/akm-config.json.
 * Pure function (no process.exit, no console output) so tests can call it
 * directly instead of spawning a subprocess.
 */
export function checkSchemaDrift(): { upToDate: boolean; generated: string; existing: string } {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const target = path.join(repoRoot, "schemas", "akm-config.json");
  const generated = `${JSON.stringify(generate(), null, 2)}\n`;
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  return { upToDate: existing === generated, generated, existing };
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const repoRoot = path.resolve(import.meta.dir, "..");
  const target = path.join(repoRoot, "schemas", "akm-config.json");

  if (checkMode) {
    const { upToDate } = checkSchemaDrift();
    if (!upToDate) {
      console.error(
        `schemas/akm-config.json is stale. Run \`bun scripts/gen-config-schema.ts\` to regenerate.`,
      );
      process.exit(1);
    }
    console.log("schemas/akm-config.json is up to date.");
    return;
  }
  const generated = `${JSON.stringify(generate(), null, 2)}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generated);
  console.log(`Wrote ${target}`);
}

if (import.meta.main) {
  main();
}
