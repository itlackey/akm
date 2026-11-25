// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** How a config file is read: its retired forms lifted to the current shape, and its unknown keys named. */

import { isRecord } from "../common";
import { getConfigPath } from "../paths";
import { isRefToken } from "../ref-token";
import { warnOnce } from "../warn";
import { parseConfigText, readConfigText } from "./config-io";
import { AkmConfigSchema, CURRENT_CONFIG_VERSION } from "./config-schema";
import { isOpaqueSchema, resolveSchemaAt } from "./config-walker";
import { convertBundleComponents } from "./convert-bundle-components";
import { convertEngineConfig } from "./convert-engines";
import { isPlainObject } from "./deep-merge";
import { readModelsFile } from "./models-file";
import { type EngineTargets, rememberedEngineTargets } from "./retired-engines";

/**
 * Run the per-file config pipeline every raw config object goes through
 * before it is either validated (the local/top-level file) or merged in as
 * an `extends` base: JSONC parse already done by the caller, then the retired
 * `engines` form read as `connections`/`harnesses` ({@link readRetiredEngines})
 * and the `configVersion` read ({@link readConfigVersion}). Unknown keys are not an
 * error: the schema drops them in memory. A shape older than 0.9.15 is not
 * converted here; it fails validation with a message naming `akm migrate
 * apply` under akm 0.9.x. Shared by {@link parseAndValidateConfigText} (the
 * local file) and {@link resolveExtendsChain} (each base in the chain) so a
 * fleet-shared base config can carry its own `configVersion` independently of
 * the file that extends it.
 */
export function runConfigFilePipeline(text: string, sourcePath?: string): Record<string, unknown> {
  return readRetiredForms(readConfigFile(text, sourcePath), sourcePath);
}

/**
 * A config file as it says it: parsed, with the retired `secret://` forms and
 * `configVersion` read, and nothing else converted. An ordinary write edits this
 * document, so what a read converts in memory (the retired `engines` form) is
 * not rewritten until `akm migrate apply`.
 */
export function readConfigFile(text: string, sourcePath?: string): Record<string, unknown> {
  const raw = parseConfigText(text, sourcePath);
  const lifted = readRetiredSecretRefs(raw, [], sourcePath) as Record<string, unknown>;
  return readConfigVersion(lifted, sourcePath);
}

/** The overlay every file read folds in, unless the migrator is reading an `extends` base without it. */
let modelsOverlayOverride: { readonly overlay: unknown } | undefined;

/** Run `fn` with no models.json overlay folded into file reads. */
export function withoutModelsOverlay<T>(fn: () => T): T {
  modelsOverlayOverride = { overlay: undefined };
  try {
    return fn();
  } finally {
    modelsOverlayOverride = undefined;
  }
}

export function modelsOverlay(): unknown {
  return modelsOverlayOverride ? modelsOverlayOverride.overlay : readModelsFile();
}

/**
 * What each old engine name now is, so an `engine:` selector (a flag, or a key in an asset or a task source)
 * keeps meaning the service it always named: the conversion renames the engine `defaults` named to `default`
 * and moves an old `default` aside. While the file is still in the `engines` form the answer is the
 * conversion's own; after `akm migrate apply` has rewritten it, the names the migrator remembered, until
 * every reference it can rewrite is rewritten. Resolution and the migrator both ask here.
 */
export function retiredEngineTargets(): EngineTargets {
  const configPath = getConfigPath();
  const text = readConfigText(configPath);
  if (text === undefined) return {};
  const live = convertEngineConfig(readConfigFile(text, configPath), {
    modelsOverlay: modelsOverlay(),
    env: process.env,
  }).targets;
  return Object.keys(live).length > 0 ? live : rememberedEngineTargets();
}

/**
 * `engines` / `defaults` are retired in favour of `connections` / `harnesses`.
 * A config in the old form is read as the new one, in memory, with one warning;
 * `akm migrate apply` writes it back (it runs {@link convertEngineConfig} too,
 * through this pipeline, before it deletes the keys the schema does not know).
 */
function readRetiredEngines(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const { config, notes, changed, keys } = convertEngineConfig(raw, {
    modelsOverlay: modelsOverlay(),
    env: process.env,
  });
  if (!changed) return raw;
  const keyNotes = keys.map(
    ({ engine, field }) =>
      `engines.${engine}: its ${field} is not read from config any more; \`akm migrate apply\` moves it to credentials.json.`,
  );
  const retiredForm = raw.engines !== undefined || raw.defaults !== undefined;
  warnOnce(
    `config:retired-engines:${sourcePath ?? "inline"}`,
    `${sourcePath ?? "config.json"} ${
      retiredForm
        ? "uses the retired engines/defaults form; reading it as connections/harnesses"
        : "is read with the retired models.json folded into its models"
    }. \`akm migrate apply\` rewrites config.json${retiredForm ? "" : " and moves models.json aside"}.${[...notes, ...keyNotes].map((note) => `\n  - ${note}`).join("")}`,
  );
  return config;
}

/**
 * `bundles.<name>.components` is retired: a bundle's one component only repeated it. A config in that form is read
 * with `adapter`, `root` and `writable` on the bundle, in memory, with one warning; `akm migrate apply` writes it back.
 */
function readRetiredBundleComponents(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const { config, changed, bundles } = convertBundleComponents(raw);
  if (!changed) return raw;
  warnOnce(
    `config:retired-bundle-components:${sourcePath ?? "inline"}`,
    `${sourcePath ?? "config.json"} uses the retired bundles.<name>.components form (${bundles.join(", ")}); reading its adapter, root and writable from it. \`akm migrate apply\` rewrites config.json.`,
  );
  return config;
}

/**
 * The retired `components` entry of each bundle of the config file, as written (the component's name and what it held).
 * The reader lifts them onto the bundle and forgets which keys were the component's, so `akm bundle list`, whose
 * deprecated `components` field shows exactly what the component held, reads them here. Removed in 0.11 with the field.
 */
export function retiredBundleComponents(): Map<string, { name: string; root?: string; writable?: boolean }> {
  const found = new Map<string, { name: string; root?: string; writable?: boolean }>();
  const configPath = getConfigPath();
  const text = readConfigText(configPath);
  const bundles = text === undefined ? undefined : parseConfigText(text, configPath).bundles;
  if (!isPlainObject(bundles)) return found;
  for (const [bundle, entry] of Object.entries(bundles)) {
    const [name, component] =
      isPlainObject(entry) && isPlainObject(entry.components) ? (Object.entries(entry.components)[0] ?? []) : [];
    if (name === undefined || !isPlainObject(component)) continue;
    found.set(bundle, {
      name,
      ...(typeof component.root === "string" ? { root: component.root } : {}),
      ...(typeof component.writable === "boolean" ? { writable: component.writable } : {}),
    });
  }
  return found;
}

/** Every retired form of the file the reader still takes, read as the current one. */
export function readRetiredForms(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  return readRetiredBundleComponents(readRetiredEngines(raw, sourcePath), sourcePath);
}

/** The retired `secret://<name>` credential form; it survives only in {@link readRetiredSecretRefs}. */
const SECRET_STORE_REFERENCE_PATTERN = /^secret:\/\/(.+)$/;

/**
 * The `${ref}` a retired `secret://<x>` value reads as: `${<x>}` when `<x>` is
 * already a full ref, else `${secrets/<x>}`. `undefined` for any other string.
 * Shared by the config reader and the frozen workflow runner decoder.
 */
export function liftRetiredSecretRef(value: string): string | undefined {
  const name = SECRET_STORE_REFERENCE_PATTERN.exec(value)?.[1];
  if (name === undefined) return undefined;
  return isRefToken(`\${${name}}`) ? `\${${name}}` : `\${secrets/${name}}`;
}

/**
 * `secret://<x>` is retired in favour of `${ref}`. A value in that form is read
 * as its {@link liftRetiredSecretRef} with one warning naming the key; every
 * ordinary config write and `akm migrate apply`'s `configFile` step then
 * persist the new form.
 */
function readRetiredSecretRefs(node: unknown, keyPath: readonly string[], sourcePath?: string): unknown {
  if (typeof node === "string") {
    const lifted = liftRetiredSecretRef(node);
    if (lifted === undefined) return node;
    const dotted = keyPath.join(".");
    warnOnce(
      `config:secret-scheme:${sourcePath ?? "inline"}:${dotted}`,
      `${dotted}${sourcePath ? ` at ${sourcePath}` : ""} uses the retired ${JSON.stringify(node)} form; reading it as ${JSON.stringify(lifted)}. \`akm migrate apply\` rewrites config.json.`,
    );
    return lifted;
  }
  if (Array.isArray(node))
    return node.map((child, i) => readRetiredSecretRefs(child, [...keyPath, String(i)], sourcePath));
  if (isRecord(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, readRetiredSecretRefs(child, [...keyPath, key], sourcePath)]),
    );
  }
  return node;
}

/**
 * `configVersion` is read, never gated on. `"0.9.0"` is the only value akm
 * has ever shipped, and a document without the field is that same document.
 * Any other value is named once and the file is read as the current shape
 * anyway; every ordinary config write and `akm migrate apply`'s `configFile`
 * step then persist `"0.9.0"`.
 */
function readConfigVersion(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const version = raw.configVersion;
  if (version === CURRENT_CONFIG_VERSION) return raw;
  if (version !== undefined) {
    warnOnce(
      `config:config-version${sourcePath ? `:${sourcePath}` : ""}`,
      `${sourcePath ?? "config.json"} declares configVersion ${JSON.stringify(version)}; this release reads it as ${CURRENT_CONFIG_VERSION}.`,
    );
  }
  return { ...raw, configVersion: CURRENT_CONFIG_VERSION };
}

/**
 * `output.format: html` is retired with akm's HTML output (AKM Desktop replaces it). The value is safely
 * ignorable, so the config keeps loading, the format falls back to the default, and one warning says why.
 * A read does not rewrite the file.
 */
export function dropRetiredOutputFormat(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const output = raw.output;
  if (!isRecord(output) || output.format !== "html") return raw;
  warnOnce(
    `config:output-format-html:${sourcePath ?? "inline"}`,
    `output.format "html" is no longer supported${sourcePath ? ` (${sourcePath})` : ""}: HTML reports moved to AKM Desktop. Using the default format; set output.format to json, jsonl, yaml, text or md.`,
  );
  const { format: _html, ...rest } = output;
  return { ...raw, output: rest };
}

/**
 * Retired `index.<passName>` keys that still validate against the generic
 * per-pass catchall schema (`IndexPassConfigSchema`), so `resolveSchemaAt`
 * below never returns `undefined` for them and the walk would otherwise
 * treat them as a live, ordinary pass. Named here so the same three
 * guarantees apply as any other retired config key: a config setting one keeps
 * loading, is named once by
 * the unknown-key warning, and is dropped only by `akm migrate apply`.
 * `index.graph` (the LLM entity-graph extraction pass) and
 * `index.metadataEnhance` (LLM metadata enrichment) are retired, as is
 * `index.stalenessDetection`.
 */
const RETIRED_CATCHALL_KEY_PATHS = new Set(["index.graph", "index.metadataEnhance", "index.stalenessDetection"]);

/**
 * Every dotted key in `raw` the schema does not know, at any depth (arrays
 * are not descended). Unknown keys are never an error: they are a typo, or a
 * key another release used. Reads keep them (they round-trip through
 * ordinary writes, so a newer release's settings survive a downgrade);
 * `akm migrate apply` drops them.
 */
export function unknownConfigKeyPaths(
  root: Record<string, unknown>,
  node: Record<string, unknown> = root,
  prefix: readonly string[] = [],
): string[][] {
  const found: string[][] = [];
  for (const key of Object.keys(node).sort()) {
    const keyPath = [...prefix, key];
    const schema = resolveSchemaAt(keyPath, root);
    if (RETIRED_CATCHALL_KEY_PATHS.has(keyPath.join(".")) || schema === undefined) {
      found.push(keyPath);
      continue;
    }
    // A request field on a connection (`chat_template_kwargs`, ...) is the endpoint's, not akm's: its contents are not keys akm knows.
    if (isOpaqueSchema(schema)) continue;
    const value = node[key];
    if (isRecord(value)) found.push(...unknownConfigKeyPaths(root, value, keyPath));
  }
  return found;
}

export function warnUnknownConfigKeys(raw: Record<string, unknown>, sourcePath?: string): void {
  const unknown = unknownConfigKeyPaths(raw);
  if (unknown.length === 0) return;
  // A key the schema refuses with its own message (`stashDir`, `sources`, `installed`) is reported by that message alone.
  const refused = new Set(AkmConfigSchema.safeParse(raw).error?.issues.map((issue) => issue.path.join(".")) ?? []);
  for (const keyPath of unknown) {
    const dotted = keyPath.join(".");
    if (refused.has(dotted)) continue;
    warnOnce(
      `config:unknown-key:${sourcePath ?? "inline"}:${dotted}`,
      `Unknown config key ${JSON.stringify(dotted)}${sourcePath ? ` at ${sourcePath}` : ""} has no defined akm behavior and is ignored. Check the spelling, or remove it from ${sourcePath ?? "the config"}.`,
    );
  }
}
