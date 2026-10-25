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
 *   - a task source (`tasks/`, YAML): `engine` at the top level; one older than
 *     v4 is left whole for the task step.
 *
 * An `engine:` key that stays (a style the splice does not write, a read-only
 * bundle, a conflict) is counted in `pending`, apart from the file's outcome: the
 * old names are needed for as long as one is left, in a rewritten file too
 * ({@link pendingEngineKeys}).
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
  /** The `engine:` keys this plan leaves as written (a style it does not rewrite): old names still waiting on the remembered map. */
  readonly pending: number;
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
  | (EngineKeyOutcomeBase & {
      readonly status: "skipped";
      readonly reason: string;
      /** The `engine:` keys in the file that name an old engine and are not rewritten. */
      readonly pending: number;
    });

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

/**
 * The splice that makes the scalar `node` read as `value`, in the style it was written in (plain, 'single' or
 * "double" quoted): the scalar's own range in the source, which excludes any comment after it, and the new value
 * serialized for that style, never a substring of the old spelling, which may be escaped (`"la\u0062"`). A
 * scalar written as a block, which this step does not rewrite, has none.
 */
function scalarSplice(node: unknown, value: string, offset: number): Splice | undefined {
  if (!isScalar(node) || !node.range) return undefined;
  const [start, end] = node.range;
  const text =
    node.type === "QUOTE_DOUBLE"
      ? JSON.stringify(value)
      : node.type === "QUOTE_SINGLE"
        ? `'${value.replaceAll("'", "''")}'`
        : node.type === "PLAIN" || node.type === undefined
          ? value
          : undefined;
  return text === undefined ? undefined : { start: offset + start, end: offset + end, text };
}

/** What a rewritten place must read as once the splices are made: its key and value, and no `engine` beside them. */
interface Expectation {
  readonly at: string;
  readonly key: string;
  readonly name: string;
}

function planYaml(
  yaml: string,
  offset: number,
  role: EngineKeyRole,
  resolve: ResolveEngineKey,
):
  | { splices: Splice[]; rewrites: EngineKeyRewrite[]; notes: string[]; expected: Expectation[]; references: number }
  | { problem: string; references: number } {
  const document = parseDocument(yaml);
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return { problem: "it is not YAML this step can read", references: 0 };
  }
  const splices: Splice[] = [];
  const rewrites: EngineKeyRewrite[] = [];
  const notes: string[] = [];
  const expected: Expectation[] = [];
  /** The `engine:` keys that name an old engine: the ones the remembered names are kept for. */
  let references = 0;
  const places = enginePlaces(document.contents, role);
  // A task source older than v4 still on disk is one the task step left blocked: the key waits for that step, and
  // the old names for it.
  const version = pairOf(document.contents, "version")?.value;
  const blocked = role === "task" && !(isScalar(version) && version.value === 4);
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
    references += 1;
    if (blocked) continue;
    const resolution = resolve(value);
    const newKey = scalarSplice(pair.key, resolution.key, offset);
    const newName = resolution.name === value ? undefined : scalarSplice(pair.value, resolution.name, offset);
    if (!newKey || (resolution.name !== value && !newName)) {
      notes.push(`${where}: left as written, because it is spelled in a style this step does not rewrite.`);
      continue;
    }
    splices.push(newKey);
    if (newName) splices.push(newName);
    rewrites.push({ at: where, from: `engine: ${value}`, to: `${resolution.key}: ${resolution.name}` });
    expected.push({ at, key: resolution.key, name: resolution.name });
    if (resolution.note) notes.push(`${where}: ${resolution.note}`);
  }
  if (blocked && places.some(({ map }) => pairOf(map, "engine"))) {
    return { problem: "it is not task source v4; convert it to v4 first, then run this step again", references };
  }
  return { splices, rewrites, notes, expected, references };
}

/** Whether `yaml` now reads as the planned places do: the key and name written, no `engine` left beside them. */
function readsAsPlanned(yaml: string, role: EngineKeyRole, expected: readonly Expectation[]): boolean {
  const document = parseDocument(yaml);
  if (document.errors.length > 0 || !isMap(document.contents)) return false;
  const places = new Map(enginePlaces(document.contents, role).map(({ at, map }) => [at, map]));
  return expected.every(({ at, key, name }) => {
    const map = places.get(at);
    const value = map ? pairOf(map, key)?.value : undefined;
    const stale = key !== "engine" && map ? pairOf(map, "engine") : undefined;
    return isScalar(value) && value.value === name && stale === undefined;
  });
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

  const frontmatter = input.role === "task" ? { text: raw, offset: 0 } : frontmatterOf(raw);
  if (!frontmatter) return { ...base, status: "unchanged" };
  const planned = planYaml(frontmatter.text, frontmatter.offset, input.role, resolve);
  if ("problem" in planned) {
    return { ...base, status: "skipped", reason: planned.problem, pending: planned.references };
  }
  if (planned.rewrites.length === 0) {
    return planned.notes.length > 0
      ? { ...base, status: "skipped", reason: planned.notes.join(" "), pending: planned.references }
      : { ...base, status: "unchanged" };
  }
  if (!input.writable) {
    return {
      ...base,
      status: "skipped",
      reason: "its bundle is read-only; change the asset where it comes from",
      pending: planned.references,
    };
  }

  const after = Buffer.from(applySplices(raw, planned.splices), "utf8");
  // What is written must read as YAML, and as the keys and names that were planned.
  const written = input.role === "task" ? after.toString("utf8") : frontmatterOf(after.toString("utf8"))?.text;
  if (written === undefined || !readsAsPlanned(written, input.role, planned.expected)) {
    return {
      ...base,
      status: "skipped",
      reason: "the rewrite would not read as planned, so it was not made",
      pending: planned.references,
    };
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
    pending: planned.references - planned.rewrites.length,
  };
}

/** The `engine:` keys a plan leaves naming an old engine, or would leave if it were not applied: zero means the remembered names are no longer needed. */
export function pendingEngineKeys(plan: EngineKeysPlan): number {
  let pending = 0;
  for (const file of plan.files) {
    if (file.status === "changed") pending += file.pending + file.rewrites.length;
    else if (file.status === "skipped") pending += file.pending;
  }
  return pending;
}

export function planEngineKeys(inputs: readonly EngineKeyFileInput[], resolve: ResolveEngineKey): EngineKeysPlan {
  return {
    files: inputs
      .map((input) => planEngineKeyFile(input, resolve))
      .filter((outcome) => outcome.status !== "unchanged")
      .sort((a, b) => a.filePath.localeCompare(b.filePath)),
  };
}
