// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure planner for the `assetEngineKeys` step: an asset that still says
 * `engine: <name>` is rewritten to `connection: <name>` or `harness: <name>`,
 * whichever the name now is. The runtime reads `engine:` as a connection by that
 * name, else a harness, with a one-time notice (`warnRetiredEngineKey`); this
 * makes the choice durable.
 *
 * Only the key (and the name, when the conversion renamed its engine) is
 * touched: the rewrite is a splice into the source text at the key's own
 * position, so comments, quoting, order and line endings stay as written.
 *
 * The keys, by what the file is:
 *   - a command or agent (`commands/`, `agents/`): `engine` at the top level and
 *     `akm.engine`;
 *   - a workflow (`workflows/`): `defaults.engine`, and `engine` on a step's
 *     `unit` and on the `unit` of its `map`;
 *   - a task source (`tasks/`, YAML): `engine` at the top level.
 */

import crypto from "node:crypto";
import { isMap, isScalar, isSeq, parseDocument, type Pair, type YAMLMap } from "yaml";

export type EngineKeyRole = "command" | "workflow" | "task";

export interface EngineKeyFileInput {
  readonly filePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly role: EngineKeyRole;
  /** False for a bundle akm may not change (installed from a registry). */
  readonly writable: boolean;
}

/** What an `engine:` value now is: the key to write, and the name to write after it. */
export interface EngineKeyResolution {
  readonly key: "connection" | "harness";
  readonly name: string;
  /** Set when the name is neither a connection nor a harness: `harness:` is a guess the user should look at. */
  readonly note?: string;
}

export type ResolveEngineKey = (engine: string) => EngineKeyResolution;

export interface EngineKeyRewrite {
  /** The key path in the file, such as `steps[0].unit.engine`. */
  readonly at: string;
  readonly from: string;
  readonly to: string;
}

interface EngineKeyOutcomeBase {
  readonly filePath: string;
  readonly beforeHash: string;
}

export interface EngineKeyChange extends EngineKeyOutcomeBase {
  readonly status: "changed";
  readonly before: Buffer;
  readonly after: Buffer;
  readonly afterHash: string;
  readonly mode: number;
  readonly rewrites: readonly EngineKeyRewrite[];
  readonly notes: readonly string[];
}

export type EngineKeyOutcome =
  | (EngineKeyOutcomeBase & { readonly status: "unchanged" })
  | EngineKeyChange
  | (EngineKeyOutcomeBase & { readonly status: "skipped"; readonly reason: string });

export interface EngineKeysPlan {
  readonly files: readonly EngineKeyOutcome[];
}

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

/** The `---` block at the top of a Markdown file: its text and where in the file that text starts. */
function frontmatterOf(raw: string): { text: string; offset: number } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  return match ? { text: match[1] as string, offset: raw.indexOf("\n") + 1 } : undefined;
}

const pairOf = (map: YAMLMap, key: string): Pair | undefined =>
  map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);

const mapOf = (map: YAMLMap | undefined, key: string): YAMLMap | undefined => {
  const value = map ? pairOf(map, key)?.value : undefined;
  return isMap(value) ? value : undefined;
};

/** The maps of a document that can hold an `engine:` key, by the role of the file. */
function enginePlaces(root: YAMLMap, role: EngineKeyRole): Array<{ at: string; map: YAMLMap }> {
  const places: Array<{ at: string; map: YAMLMap | undefined }> = [];
  if (role === "workflow") {
    places.push({ at: "defaults", map: mapOf(root, "defaults") });
    const steps = pairOf(root, "steps")?.value;
    if (isSeq(steps)) {
      steps.items.forEach((step, index) => {
        const stepMap = isMap(step) ? step : undefined;
        places.push({ at: `steps[${index}].unit`, map: mapOf(stepMap, "unit") });
        places.push({ at: `steps[${index}].map.unit`, map: mapOf(mapOf(stepMap, "map"), "unit") });
      });
    }
  } else {
    places.push({ at: "", map: root });
    if (role === "command") places.push({ at: "akm", map: mapOf(root, "akm") });
  }
  return places.flatMap(({ at, map }) => (map ? [{ at, map }] : []));
}

interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The scalar's own text in `source`, and its range, which excludes any comment after it. */
function scalarText(node: unknown, source: string): { start: number; end: number; text: string } | undefined {
  if (!isScalar(node) || !node.range) return undefined;
  const [start, end] = node.range;
  return { start, end, text: source.slice(start, end) };
}

function planYaml(
  yaml: string,
  offset: number,
  role: EngineKeyRole,
  resolve: ResolveEngineKey,
): { splices: Splice[]; rewrites: EngineKeyRewrite[]; notes: string[] } | { problem: string } {
  const document = parseDocument(yaml);
  if (document.errors.length > 0 || !isMap(document.contents)) return { problem: "it is not YAML this step can read" };
  const splices: Splice[] = [];
  const rewrites: EngineKeyRewrite[] = [];
  const notes: string[] = [];
  const places = enginePlaces(document.contents, role);
  // A task source older than v4 still on disk is one the task step left blocked: renaming a key in it would keep the
  // task step from converting it once the blocker is fixed.
  const version = pairOf(document.contents, "version")?.value;
  if (role === "task" && places.some(({ map }) => pairOf(map, "engine")) && !(isScalar(version) && version.value === 4)) {
    return { problem: "it is not task source v4; convert it to v4 first, then run this step again" };
  }
  for (const { at, map } of places) {
    const pair = pairOf(map, "engine");
    if (!pair) continue;
    const where = at === "" ? "engine" : `${at}.engine`;
    const value = isScalar(pair.value) ? pair.value.value : undefined;
    if (typeof value !== "string" || value.trim() === "") {
      notes.push(`${where}: left as written, because it does not name an engine.`);
      continue;
    }
    if (pairOf(map, "connection") || pairOf(map, "harness")) {
      notes.push(`${where}: left as written, because the same place also names a connection or a harness.`);
      continue;
    }
    const resolution = resolve(value);
    const key = scalarText(pair.key, yaml);
    const name = scalarText(pair.value, yaml);
    if (!key || !name) continue;
    splices.push({ start: offset + key.start, end: offset + key.end, text: key.text.replace("engine", resolution.key) });
    if (resolution.name !== value) {
      splices.push({ start: offset + name.start, end: offset + name.end, text: name.text.replace(value, resolution.name) });
    }
    rewrites.push({ at: where, from: `engine: ${value}`, to: `${resolution.key}: ${resolution.name}` });
    if (resolution.note) notes.push(`${where}: ${resolution.note}`);
  }
  return { splices, rewrites, notes };
}

function applySplices(source: string, splices: readonly Splice[]): string {
  let out = source;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  }
  return out;
}

/** One file: its `engine:` keys rewritten, or why it was left alone. */
export function planEngineKeyFile(input: EngineKeyFileInput, resolve: ResolveEngineKey): EngineKeyOutcome {
  const beforeHash = sha256(input.bytes);
  const raw = input.bytes.toString("utf8");
  const base = { filePath: input.filePath, beforeHash };
  if (!raw.includes("engine")) return { ...base, status: "unchanged" };

  const frontmatter = input.role === "task" ? { text: raw, offset: 0 } : frontmatterOf(raw);
  if (!frontmatter) return { ...base, status: "unchanged" };
  const planned = planYaml(frontmatter.text, frontmatter.offset, input.role, resolve);
  if ("problem" in planned) return { ...base, status: "skipped", reason: planned.problem };
  if (planned.rewrites.length === 0) {
    return planned.notes.length > 0
      ? { ...base, status: "skipped", reason: planned.notes.join(" ") }
      : { ...base, status: "unchanged" };
  }
  if (!input.writable) {
    return { ...base, status: "skipped", reason: "its bundle is read-only; change the asset where it comes from" };
  }

  const after = Buffer.from(applySplices(raw, planned.splices), "utf8");
  // What is written must still read as YAML.
  const written = input.role === "task" ? after.toString("utf8") : frontmatterOf(after.toString("utf8"))?.text;
  if (written === undefined || parseDocument(written).errors.length > 0) {
    return { ...base, status: "skipped", reason: "the rewrite would not leave valid YAML, so it was not made" };
  }
  return {
    ...base,
    status: "changed",
    before: input.bytes,
    after,
    afterHash: sha256(after),
    mode: input.mode,
    rewrites: planned.rewrites,
    notes: planned.notes,
  };
}

export function planEngineKeys(inputs: readonly EngineKeyFileInput[], resolve: ResolveEngineKey): EngineKeysPlan {
  return {
    files: inputs
      .map((input) => planEngineKeyFile(input, resolve))
      .filter((outcome) => outcome.status !== "unchanged")
      .sort((a, b) => a.filePath.localeCompare(b.filePath)),
  };
}
