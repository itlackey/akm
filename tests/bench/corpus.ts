/**
 * akm-bench corpus loader (spec §5.4 + §13.1).
 *
 * Tasks live at `tests/fixtures/bench/tasks/<domain>/<task-id>/task.yaml`. Each
 * task is a flat YAML record (see §13.1). The schema lands in #237 and grows
 * over time; #236 only ships the loader and one sample task fixture.
 *
 * The `tests/fixtures/bench/tasks/` directory may not exist on `release/1.0.0`
 * yet — that's #237's deliverable. `listTasks()` MUST return `[]` cleanly when
 * the directory is missing rather than throwing, so consumers degrade gracefully.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export type TaskSlice = "train" | "eval";
export type TaskDifficulty = "easy" | "medium" | "hard";
export type TaskVerifier = "script" | "pytest" | "regex";

export interface TaskMetadata {
  /** `<domain>/<task-name>`, kebab-case. */
  id: string;
  title: string;
  domain: string;
  difficulty: TaskDifficulty;
  /** When omitted in `task.yaml`, partitionSlice() assigns one. */
  slice?: TaskSlice;
  goldRef?: string;
  /** Required: name of a fixture stash under `tests/fixtures/stashes/`. */
  stash: string;
  /** Optional: path to extra assets layered on top of the named fixture. */
  stashOverlay?: string;
  verifier: TaskVerifier;
  /** Required when `verifier === "regex"`. */
  expectedMatch?: string;
  budget: { tokens: number; wallMs: number };
  /** Absolute path to the directory containing `task.yaml`. */
  taskDir: string;
  /**
   * Optional override for the akm-arm `stashDir` plumbed into `runOne`.
   *
   * Used by `runMaskedCorpus` (#251) to redirect the runner at a tmp stash
   * with one asset removed without mutating the on-disk fixture stash named
   * by `stash`. When set, the runner forwards this directory verbatim as
   * `AKM_STASH_DIR` for every akm-arm invocation of this task — bypassing
   * the per-task `loadFixtureStash` step (which would otherwise re-resolve
   * `stash` against `tests/fixtures/stashes/`) and the `__no-stash__`
   * placeholder used when `materialiseStash` is `false`.
   *
   * MUST be a directory the caller created and is responsible for cleaning
   * up. The runner does not delete it.
   */
  stashDirOverride?: string;
}

const TASKS_ROOT = path.resolve(__dirname, "..", "fixtures", "bench", "tasks");

/** Public for tests; resolves the corpus root in case callers need to assert it. */
export function getTasksRoot(): string {
  return TASKS_ROOT;
}

/**
 * Compute a deterministic SHA-256 hash over a selected task corpus (#250).
 *
 * Two reports with the same selected task IDs and the same task body bytes
 * produce the same hash. The hash is order-independent: callers may pass IDs
 * in any order — the function sorts them lexicographically before hashing.
 *
 * The `taskBodies` map is keyed by task id and carries the raw `task.yaml`
 * bytes (or any deterministic per-task identity payload). Tasks present in
 * `taskIds` but missing from `taskBodies` are hashed with an empty body so
 * the hash still distinguishes the selection.
 *
 * Encoding (per id, in sorted order):
 *   `<id>\0<body-bytes>\0`
 *
 * Used by `bench compare` to refuse mismatched corpora unless the operator
 * explicitly opts in via `--allow-corpus-mismatch`.
 */
export function computeTaskCorpusHash(taskIds: string[], taskBodies: Map<string, string>): string {
  const sortedIds = [...taskIds].sort();
  const hash = createHash("sha256");
  for (const id of sortedIds) {
    hash.update(id);
    hash.update("\0");
    hash.update(taskBodies.get(id) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Read the raw `task.yaml` bytes for a task whose `taskDir` is known. Returns
 * the empty string when the file is missing — callers should still hash the
 * id so the selection's identity is preserved.
 */
export function readTaskBody(taskDir: string): string {
  const yamlPath = path.join(taskDir, "task.yaml");
  try {
    return fs.readFileSync(yamlPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * The `_example/` task tree is reserved for loader unit tests; real corpus
 * statistics must exclude it. The path-prefix check matches both POSIX (`/`)
 * and Windows (`\`) separators.
 */
const EXAMPLE_PREFIX = `${path.sep}_example${path.sep}`;

function isExampleTaskDir(dir: string): boolean {
  return dir.includes(EXAMPLE_PREFIX);
}

/**
 * Load a single task by id. Walks the tasks tree until a directory whose
 * `task.yaml` carries the requested `id` is found. By default the
 * `_example/` tree is skipped; pass `{ includeExamples: true }` to load
 * tasks under that prefix (used by loader-unit tests).
 *
 * Throws if the corpus directory is missing or no task matches.
 */
export function loadTask(taskId: string, options: { includeExamples?: boolean } = {}): TaskMetadata {
  if (!fs.existsSync(TASKS_ROOT)) {
    throw new Error(`bench corpus directory missing: ${TASKS_ROOT}`);
  }
  for (const candidate of walkTaskDirs(TASKS_ROOT)) {
    if (!options.includeExamples && isExampleTaskDir(candidate)) continue;
    const meta = readTask(candidate);
    if (meta && meta.id === taskId) return meta;
  }
  throw new Error(`task not found: ${taskId}`);
}

export interface ListTasksOptions {
  slice?: TaskSlice;
  /**
   * Include tasks under the `_example/` tree. Defaults to `false` so corpus
   * statistics match the real seeded corpus. Loader-unit tests set this to
   * `true` to address the shipped sample task explicitly.
   */
  includeExamples?: boolean;
}

/**
 * Return every task in the corpus, optionally filtered by `slice`. When the
 * corpus directory is missing this returns `[]`. By default tasks under the
 * `_example/` tree are excluded; pass `{ includeExamples: true }` to include
 * them.
 */
export function listTasks(options: ListTasksOptions = {}): TaskMetadata[] {
  if (!fs.existsSync(TASKS_ROOT)) return [];
  const out: TaskMetadata[] = [];
  for (const dir of walkTaskDirs(TASKS_ROOT)) {
    if (!options.includeExamples && isExampleTaskDir(dir)) continue;
    const meta = readTask(dir);
    if (!meta) continue;
    if (options.slice) {
      // Tasks without an explicit `slice:` are partitioned by id-hash so the
      // filter behaves consistently with `partitionSlice()`. Without this,
      // an unsliced task would always pass through both `slice: "train"` and
      // `slice: "eval"` filters, double-counting in evaluation reports.
      if (effectiveSlice(meta) !== options.slice) continue;
    }
    out.push(meta);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Partition a list of tasks into train/eval slices. Tasks declaring an explicit
 * `slice:` are honoured; tasks that don't are placed by `id-hash mod 2 === 0`
 * → train, else eval. The hash is SHA-1 of the id (deterministic across hosts).
 */
export function partitionSlice(tasks: TaskMetadata[]): { train: TaskMetadata[]; eval: TaskMetadata[] } {
  const train: TaskMetadata[] = [];
  const evalSlice: TaskMetadata[] = [];
  for (const task of tasks) {
    const slice = effectiveSlice(task);
    if (slice === "train") train.push(task);
    else evalSlice.push(task);
  }
  return { train, eval: evalSlice };
}

function assignSliceByHash(id: string): TaskSlice {
  // SHA-1 first byte parity is stable, fast, and uniformly distributed enough
  // for slice partitioning. We avoid `node:crypto.randomInt` (non-deterministic).
  const digest = createHash("sha1").update(id).digest();
  return digest[0] % 2 === 0 ? "train" : "eval";
}

/**
 * Resolve a task's effective slice. If `task.yaml` declares `slice:` we honour
 * it; otherwise the id-hash partition assigns one deterministically. Exported
 * so that consumers (and tests) can ask "which slice would this task fall in?"
 * without re-running `partitionSlice()`.
 */
export function effectiveSlice(task: Pick<TaskMetadata, "id" | "slice">): TaskSlice {
  return task.slice ?? assignSliceByHash(task.id);
}

/** Walk the corpus tree depth-first, yielding every directory containing a `task.yaml`. */
function* walkTaskDirs(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === "task.yaml")) {
      yield dir;
      continue; // Don't recurse beneath a task directory.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
}

interface RawTask {
  id?: unknown;
  title?: unknown;
  domain?: unknown;
  difficulty?: unknown;
  slice?: unknown;
  gold_ref?: unknown;
  stash?: unknown;
  stash_overlay?: unknown;
  verifier?: unknown;
  expected_match?: unknown;
  budget?: { tokens?: unknown; wallMs?: unknown };
}

function readTask(taskDir: string): TaskMetadata | undefined {
  const yamlPath = path.join(taskDir, "task.yaml");
  let text: string;
  try {
    text = fs.readFileSync(yamlPath, "utf8");
  } catch {
    return undefined;
  }
  let raw: RawTask;
  try {
    raw = parseYaml(text) as RawTask;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  const id = asString(raw.id);
  const title = asString(raw.title);
  const domain = asString(raw.domain);
  const difficulty = asEnum<TaskDifficulty>(raw.difficulty, ["easy", "medium", "hard"]);
  const stash = asString(raw.stash);
  const verifier = asEnum<TaskVerifier>(raw.verifier, ["script", "pytest", "regex"]);
  const tokens = asNumber(raw.budget?.tokens);
  const wallMs = asNumber(raw.budget?.wallMs);

  if (!id || !title || !domain || !difficulty || !stash || !verifier || tokens === undefined || wallMs === undefined) {
    return undefined;
  }

  const slice = raw.slice === undefined ? undefined : asEnum<TaskSlice>(raw.slice, ["train", "eval"]);
  const goldRef = asString(raw.gold_ref);
  const stashOverlay = asString(raw.stash_overlay);
  const expectedMatch = asString(raw.expected_match);

  const meta: TaskMetadata = {
    id,
    title,
    domain,
    difficulty,
    stash,
    verifier,
    budget: { tokens, wallMs },
    taskDir,
  };
  if (slice !== undefined) meta.slice = slice;
  if (goldRef !== undefined) meta.goldRef = goldRef;
  if (stashOverlay !== undefined) meta.stashOverlay = stashOverlay;
  if (expectedMatch !== undefined) meta.expectedMatch = expectedMatch;
  return meta;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
