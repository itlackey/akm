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
/** Refresh the existing index for files just written inside a bundle; fail-open, `false` when the index could not be updated. */
export function indexWrittenAssets(stashDir: string, filePaths: string[], options?: { bundleId?: string }): Promise<boolean>;

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
  function meta(): { version: string; hostname: string; runtime: string };
  function overview(input?: { probe?: boolean; metricsSince?: string }): Promise<unknown>;
  function pulse(): unknown;
  function retrievalTrend(input?: { since?: string }): unknown;
  function taskHistory(input: { taskId?: string; since?: string; limit?: number }): unknown;
}
export namespace assets {
  function bundleFiles(input: { bundle: string; path?: string; hidden?: boolean }): unknown;
  function history(input: { ref: string; revision?: string; limit?: number }): Promise<unknown>;
  /** What improve proposed for one asset, how it was decided, and how the asset has been used since. */
  function improvement(input: { ref: string }): unknown;
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
}
export namespace bundles {
  function add(input: { source: string; name?: string; writable?: boolean }): Promise<unknown>;
  function list(): Promise<unknown>;
  function remove(input: { bundle: string; confirm: boolean }): Promise<unknown>;
  function rename(input: { bundle: string; name: string; dryRun?: boolean }): Promise<unknown>;
  function setSettings(input: {
    bundle?: string;
    enabled?: boolean;
    writable?: boolean;
    componentWritability?: Record<string, boolean>;
  }): { saved: boolean };
  function update(input: { bundle: string }): Promise<unknown>;
}
export namespace config {
  function change(input: { set?: Record<string, string>; unset?: string[] }): { saved: boolean };
  function changeProjects(input: { set?: Record<string, Record<string, unknown>>; unset?: string[] }): {
    saved: boolean;
  };
  function get(): unknown;
  /** Remove one connection; reports the `connection` references to it, whether it was the default and the default after. */
  function removeConnection(input: { name: string }): {
    saved: boolean;
    references: string[];
    wasDefault: boolean;
    defaultConnection: string | null;
    stillInherited: boolean;
  };
}
export namespace documents {
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
    path: string;
    writable: boolean;
    revision: string;
    location: { bundle: string; path: string; parent: string };
  };
  /** The one result that carries a value; the host decides who may call it. */
  function readValue(input: SensitiveSelector): { content: string; revision: string };
  function remove(input: SensitiveSelector & { revision: string }): Promise<SensitiveWriteResult & { removed: true }>;
  /** Create (no `revision`; an existing file is refused) or replace (the `revision` last seen). */
  function save(input: SensitiveSelector & { content: string; revision?: string }): Promise<SensitiveWriteResult & { revision: string }>;
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
     * Background learning: `on` when akm's model calls run somewhere and the config does not switch every learning
     * process off, so a session-end extract or an improve run could spend quota; `agent` is the platform they run on,
     * `null` for akm itself or when off.
     */
    learning: { on: boolean; agent: string | null };
  }
  /**
   * Create the library, or with `harness` enable those agent programs. `connection` writes the default connection
   * (the variable's name, never a key). `learning` turns background learning off (each learning process switched off
   * in the active strategy, the scheduled improve task disabled) or on (those switches cleared, improve sent to
   * `agent` or else the connection, the task enabled). Returns `detect()` afterwards. Unknown fields are ignored with a warning.
   */
  function apply(input: {
    dir?: string;
    harness?: string[];
    connection?: { endpoint: string; model: string; apiKeyEnv?: string };
    learning?: { on: boolean; agent?: string };
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
