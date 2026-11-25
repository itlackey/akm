// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Hand-written declarations for `akm-cli/workspace` (the build emits no .d.ts).
// tests/contracts/workspace-surface.test.ts keeps this file and src/workspace.ts in step.
// Read models are declared `unknown`: a host types the fields it reads.

export type AkmErrorKind = "config" | "usage" | "not-found" | "transient";

export abstract class AkmError extends Error {
  abstract readonly kind: AkmErrorKind;
  /** Stable, machine-readable code. */
  abstract readonly code: string;
  abstract hint(): string | undefined;
}
export class UsageError extends AkmError {
  readonly kind: "usage";
  readonly code: string;
  constructor(msg: string, code?: string, hint?: string);
  hint(): string | undefined;
}
export class NotFoundError extends AkmError {
  readonly kind: "not-found";
  readonly code: string;
  constructor(msg: string, code?: string, hint?: string);
  hint(): string | undefined;
}
export class ConfigError extends AkmError {
  readonly kind: "config";
  readonly code: string;
  constructor(msg: string, code?: string, hint?: string);
  hint(): string | undefined;
}
export class TransientError extends AkmError {
  readonly kind: "transient";
  readonly code: string;
  constructor(msg: string, code: string, hint?: string);
  hint(): string | undefined;
}

/** Codes that mean "reload and decide again" whatever their kind: a host maps them to one conflict status. */
export const CONFLICT_CODES: ReadonlySet<string>;

export function scrubUrlCredentials(value: unknown): unknown;
/** Forget what the adapters read of keyrings and vaults: a host serving many requests calls it at the start of each, so a store changed meanwhile is read afresh. */
export function clearAdapterCaches(): void;
/** Refresh the existing index for files (absolute paths) just written inside a directory bundle; fail-open, `false` when the index could not be updated. */
export function indexFiles(bundle: string, files: string[]): Promise<boolean>;
/** Make the vectors of the rows this request's writes recorded, when semantic search is on; fail-open. A host calls it before a request ends. */
export function embedPendingWrites(): Promise<void>;

/** The file: its ref, or its bundle-relative path in a named bundle. */
export interface SensitiveSelector {
  ref?: string;
  bundle?: string;
  file?: string;
}
export interface SensitiveWriteResult {
  bundle: string;
  file: string;
  ref: string;
  warnings: string[];
}
export interface CloneResponse {
  source: { path: string; registryId?: string };
  destination: { path: string; ref?: string };
  overwritten: boolean;
  remoteFetched?: { origin: string; stashRoot: string; cacheDir: string };
}

export namespace activity {
  function health(input?: { probe?: boolean }): Promise<unknown>;
  function improveImpact(input?: { since?: string }): unknown;
  /** One improve run by id, however old, in the shape of an overview `improveRuns` entry. */
  function improveRun(input: { id: string }): unknown;
  function meta(): { version: string; hostname: string; runtime: string };
  /** The daily usage report for Desktop: sent at most once a UTC day, opt out with `usage.report: false`. Never rejects; `true` when sent. */
  function reportUsage(): Promise<boolean>;
  /** Every search, show, feedback and curate row of the window, from every source, oldest first. */
  function events(input?: { since?: string; until?: string }): unknown;
  function overview(input?: { probe?: boolean; metricsSince?: string }): Promise<unknown>;
  function pulse(): unknown;
  function retrievalTrend(input?: { since?: string }): unknown;
  function taskHistory(input: { taskId?: string; since?: string; limit?: number }): unknown;
  /** Every scheduled-task run that started in the window, for all tasks, newest first. */
  function taskRuns(input?: { since?: string }): unknown;
  /** One task run's recorded output (`logs.db`), oldest line first; `available: false` when there is no `logs.db`. */
  function taskRunLog(input: { taskId?: string; startedAt?: string }): unknown;
  /** One workflow run with its steps, units, each unit's attempts, and its child runs. */
  function workflowRun(input: { id: string }): unknown;
  /** The workflow runs created in the window, or still active, newest first. */
  function workflowRuns(input?: { since?: string }): unknown;
}
export namespace assets {
  function bundleFiles(input: { bundle: string; path?: string; hidden?: boolean }): unknown;
  /** Every asset of the enabled bundles and the declared links between them, in column form, with positions by meaning. */
  function graph(): Promise<unknown>;
  function history(input: { ref: string; revision?: string; limit?: number }): Promise<unknown>;
  /** What improve proposed for one asset, how it was decided, and how the asset has been used since. */
  function improvement(input: { ref: string }): unknown;
  /**
   * Per akm bundle, the links that name the old ref of an asset renamed or moved on disk, with the ref it has now. A
   * read-only bundle is listed too (`writable: false`, `writeBlocker`); nothing is written.
   */
  function movedLinks(input?: { bundle?: string }): Promise<{
    bundles: Array<{
      bundle: string;
      writable: boolean;
      writeBlocker: string | null;
      links: Array<{ ref: string; file: string; from: string; to: string }>;
    }>;
    total: number;
  }>;
  /**
   * Copy a file or folder to a folder of a bundle (the same or another): a new file wherever the person puts it, staged and
   * renamed into place, indexed, committed by the bundle's Git policy, with a Markdown asset recording its origin in `sources`.
   * Nothing is overwritten; env and secret files and managed folders are refused.
   */
  function copyEntry(input: {
    bundle: string;
    from: string;
    toBundle?: string;
    folder?: string;
    name: string;
  }): Promise<{
    bundle: string;
    from: string;
    toBundle: string;
    to: string;
    indexed: boolean;
  }>;
  function related(input: { ref: string; scope?: "all" | "bundle" }): Promise<unknown>;
  function search(input: {
    q: string;
    type?: string;
    bundle?: string;
    belief?: string;
    scope?: Partial<Record<"user" | "agent" | "run" | "channel", string | string[]>>;
    /** A configured project: its `from`, `filters` and `prefer` apply where this input names no such kind. */
    project?: string;
    limit?: number;
  }): Promise<unknown>;
  /** A project's effective read bundles and write bundle, with each bundle's browse total and the count its filters leave eligible. */
  function projectOverview(input: { project: string }): unknown;
  function searchMisses(input?: { since?: string }): unknown;
  function show(input: { ref: string }): Promise<unknown>;
  /** Rewrite the links to moved refs in one bundle, and nothing else; a read-only bundle is refused. */
  function updateMovedLinks(input: { bundle: string }): Promise<{ bundle: string; rewritten: number; files: string[] }>;
}
export namespace backups {
  /** `akm backups prune`: remove backups older than `olderThan` (default 30d), keeping the newest of each folder. A real run needs `confirm`; `dryRun` removes nothing. */
  function prune(input?: { olderThan?: string; dryRun?: boolean; confirm?: boolean }): Promise<Record<string, unknown>>;
}
export namespace bundles {
  /** `akm sync` for one bundle: commit every unignored change, and push when writable with a remote. Reports the commit and the push, or why nothing was committed (`output`, and `reason` when the push was skipped). */
  function commit(input: { bundle: string; message?: string; push?: boolean }): Promise<{
    bundle: string;
    committed: boolean;
    pushed: boolean;
    skipped: boolean;
    reason?: string;
    output: string;
    commit?: string;
  }>;
  function add(input: { source: string; name?: string; writable?: boolean }): Promise<unknown>;
  /** `akm index`: the incremental build. A file renamed or moved on disk is paired with the asset it was and keeps its history; the result's `moves` says which (`moved: [{from, to}]`, `unpaired`). */
  function index(): Promise<{
    totalEntries: number;
    mode: string;
    warnings?: string[];
    moves?: { moved: Array<{ from: string; to: string }>; unpaired: number };
  }>;
  function list(): Promise<unknown>;
  function remove(input: { bundle: string; confirm: boolean }): Promise<unknown>;
  function rename(input: { bundle: string; name: string; dryRun?: boolean }): Promise<unknown>;
  function setSettings(input: { bundle?: string; enabled?: boolean; writable?: boolean }): { saved: boolean };
  function update(input: { bundle: string }): Promise<unknown>;
}
export namespace children {
  /** A child akm started asynchronously, kept while it or anything in the process group it leads still runs. */
  interface StartedChild {
    readonly pid: number;
    /** The program's file name and its first argument, for messages. */
    readonly name: string;
    /** Whether it leads a process group of its own; then the group is what runs and is signalled. */
    readonly grouped: boolean;
    exited: boolean;
  }
  /** From now on every child starts in a process group of its own on POSIX, so a host can stop it with what it started. */
  function startChildrenInOwnGroups(): void;
  /** The recorded children that still run. */
  function runningChildren(): StartedChild[];
  /** Signals a recorded child: its whole process group when it leads one, otherwise the child alone. */
  function signalChild(child: StartedChild, signal: NodeJS.Signals): void;
  /** Calls `listener` with every child recorded from now on. Returns the function that stops it. */
  function onChildStarted(listener: (child: StartedChild) => void): () => void;
  /** `child_process.spawn`, recorded. */
  function spawnChild(
    file: string,
    args: readonly string[],
    options: import("node:child_process").SpawnOptions,
  ): import("node:child_process").ChildProcess;
}
export namespace config {
  function change(input: { set?: Record<string, string>; unset?: string[] }): { saved: boolean };
  function changeProjects(input: { set?: Record<string, Record<string, unknown>>; unset?: string[] }): {
    saved: boolean;
  };
  function get(): unknown;
  /** Replace one connection with `entry` as a whole (removed aliases and options leave the file); a literal API key is refused. */
  function saveConnection(input: { name: string; entry: Record<string, unknown> }): { saved: boolean };
  /** The `experimental.web` settings of `akm-web`; `secret` is the resolved value of the configured reference (`undefined` when none), and a reference that cannot be read throws an error naming it, never the value. With `{ resolveSecret: false }` the reference is not read and `secret` is omitted. */
  function webSettings(options?: { resolveSecret?: boolean }): {
    host?: string;
    port?: number;
    origin?: string;
    allowedHosts: string[];
    frameParents: string[];
    secret?: string;
  };
  /** Set the embedding model as `akm setup` does (local, a model on the default connection, or an endpoint with a `{ env }` or `{ pasted }` key); a pasted key goes to credentials.json, never config.json. */
  function saveEmbedding(input: {
    kind: "local" | "connection" | "endpoint";
    model?: string;
    endpoint?: string;
    key?: { env?: string; pasted?: string };
  }): { saved: boolean; embedding: Record<string, unknown> | null };
  /** Remove one connection; reports the `connection` references to it (each fails until changed: a named connection is never replaced by the default), whether it was the default and the default after. */
  function removeConnection(input: { name: string }): {
    saved: boolean;
    references: string[];
    wasDefault: boolean;
    defaultConnection: string | null;
    stillInherited: boolean;
  };
}
export namespace documents {
  /**
   * What akm says about text before it is saved at a path of an akm bundle: the findings `akm lint` reports for the file
   * (with their lines where the check knows one), and whether akm could still read the asset. Nothing is written.
   */
  function check(input: { bundle: string; path: string; content: string }): Promise<{
    bundle: string;
    path: string;
    type: string | null;
    findings: Array<{ issue: string; file: string; detail: string; line?: number; ref?: string }>;
    warnings: Array<{ issue: string; file: string; detail: string; line?: number; ref?: string }>;
    readable: boolean;
    unreadable?: { reason: string; line?: number };
  }>;
  /**
   * A file's frontmatter for a form: its keys and values in file order as akm's YAML reads them (`error` when the block does
   * not parse), and the keys akm knows for the file's type with the required ones marked. Parse nothing in the host.
   */
  function frontmatter(input: { bundle: string; path: string; content: string }): {
    bundle: string;
    path: string;
    type: string | null;
    present: boolean;
    /** A Markdown file, which akm reads frontmatter from. */
    markdown: boolean;
    /** Where the body starts in `content`: after the closing fence, 0 when there is no frontmatter. */
    bodyStart: number;
    entries: Array<{ key: string; value: unknown; known: boolean }>;
    error?: { reason: string; line?: number };
    keys: Array<{
      key: string;
      required: boolean;
      kind: "text" | "list" | "flag" | "map";
      values?: readonly string[];
      hint: string;
      stamped?: boolean;
    }>;
  };
  /**
   * `content` with key changes applied to its frontmatter (a key set to a value, or removed): the body and every key not
   * named stay as written. A change that cannot be made that way is refused.
   */
  function applyFrontmatter(input: {
    content: string;
    changes: Array<{ key: string; value?: unknown; remove?: true }>;
  }): { content: string; bodyStart: number };
  /** A new file in a folder of a bundle, for any type: the folder's type decides the starting text; a folder with no type gets an empty file. */
  function createFile(input: {
    bundle: string;
    folder?: string;
    type?: string;
    name: string;
    content?: string;
  }): Promise<{
    bundle: string;
    file: string;
    type: string | null;
    ref: string | null;
    path: string;
    stashDir: string;
    indexed: boolean;
  }>;
  function copy(input: { sourceRef: string; target?: string; newName?: string }): Promise<CloneResponse>;
  function createKnowledge(input: { bundle: string; name: string; path?: string; content: string }): Promise<unknown>;
  function readSource(input: {
    ref: string;
  }): Promise<{ ref: string; type: "knowledge" | "memory"; content: string; revision: string }>;
  function retire(input: { ref: string; revision: string }): Promise<{
    proposalId: string;
    ref: string;
    bundle: string;
    archiveDirs: string[];
    warnings: string[];
  }>;
  function save(input: { ref: string; content: string; revision: string }): Promise<unknown>;
}
export namespace feedback {
  function record(input: {
    ref: string;
    signal: "positive" | "negative";
    reason?: string;
    tags?: string[];
    fix?: Array<{ replace: string; with: string }>;
    source?: string;
  }): Promise<unknown>;
}
export namespace proposals {
  function accept(input: { id: string }): Promise<unknown>;
  function acceptMany(input: { ids: string[] }): Promise<unknown>;
  function get(input: { id: string }): unknown;
  function list(input?: {
    status?: string;
    source?: string;
    age?: string;
    week?: string;
    class?: string;
    limit?: number;
  }): unknown;
  function recentChanges(input?: { limit?: number }): Promise<unknown>;
  function reject(input: { id: string; reason: string }): Promise<unknown>;
  function rejectMany(input: { ids: string[]; reason: string }): Promise<unknown>;
  function reopen(input: { id: string }): Promise<unknown>;
  function revert(input: { id: string }): Promise<unknown>;
}
export namespace sensitive {
  function describe(input: SensitiveSelector): {
    ref: string;
    type: "env" | "secret";
    name: string;
    bundle: string;
    /** The file that holds it; null when its bundle keeps it elsewhere (a secret manager). */
    path: string | null;
    /** What akm accepts doing to the file: allowed, or the sentence its write path refuses with. */
    actions: Record<"edit" | "delete", { allowed: true } | { allowed: false; reason: string }>;
    revision: string;
    location: { bundle: string; path: string; parent: string };
  };
  /** The one result that carries a value; the host decides who may call it. */
  function readValue(input: SensitiveSelector): { content: string; revision: string };
  function remove(input: SensitiveSelector & { revision: string }): Promise<SensitiveWriteResult & { removed: true }>;
  /** Create (no `revision`; an existing file is refused) or replace (the `revision` last seen). */
  function save(
    input: SensitiveSelector & { content: string; revision?: string },
  ): Promise<SensitiveWriteResult & { revision: string }>;
}
export namespace setup {
  interface Detected {
    stashDir: string;
    /** Agent programs on PATH that akm can run, each with akm's words for what its model calls could do. */
    harnesses: Array<{ platform: string; path: string; modelWorkNote: string }>;
    /** The platforms the config already enables. */
    enabled: string[];
    /** Where akm's own model calls run, in setup's words, and the harness platform when they run on one. */
    modelCalls: { platform: string | null; description: string };
    /** The connection that takes akm's model calls when no agent does, or `null` when none is configured. */
    connection: string | null;
    /**
     * Background learning: `on` is the host-wide switch alone (`improve.enabled`), not whether anything is set up to
     * run; `harness` is the platform improve runs on (`null`: a connection, or nowhere); `scheduled` whether the
     * `improve` task is enabled.
     */
    learning: { on: boolean; harness: string | null; scheduled: boolean };
  }
  /**
   * Create the library, or with `harness` enable those agent programs. `connection` writes the default connection
   * (the variable's name, never a key). `learning` turns background learning off (writes `improve.enabled: false`
   * and nothing else) or on (removes it, improve sent to `harness` or else the connection, the task enabled). Returns `detect()` afterwards. Unknown fields are ignored with a warning.
   */
  function apply(input: {
    dir?: string;
    harness?: string[];
    connection?: { endpoint: string; model: string; apiKeyEnv?: string };
    learning?: { on: boolean; harness?: string };
  }): Promise<Detected>;
  /** What setup could use on this computer, from the file system, PATH and config only (no network, no writes). */
  function detect(): Promise<Detected>;
}
export namespace tasks {
  interface Task {
    id: string;
    schedule: string;
    schedules?: readonly string[];
    /** This host has the task in its scheduler configuration. */
    enabled: boolean;
    description?: string;
  }
  /** The default bundle's scheduled tasks and whether this host has each enabled. Nothing is written. */
  function list(): { tasks: Task[] };
  /** `akm task enable`: schedule the task in this host's scheduler. The OS scheduler is written. */
  function enable(input: { task: string }): Promise<Record<string, unknown>>;
  /** `akm task disable`: take the task out of this host's scheduler. */
  function disable(input: { task: string }): Promise<Record<string, unknown>>;
}
