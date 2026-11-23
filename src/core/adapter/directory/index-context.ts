import { getMeta } from "../../../storage/repositories/index-meta-repository";

/**
 * Live runtime state of semantic search, computed fresh at index-finalize
 * time. `ready-js` means every entry has a vector; there is no sqlite-vec variant.
 */
type SemanticSearchRuntimeStatus = "pending" | "ready-js" | "blocked";

/**
 * Verification of the post-index semantic-search state. Produced by the
 * finalize phase and surfaced to the `akmIndex()` caller.
 */
export interface IndexVerification {
  ok: boolean;
  message: string;
  guidance?: string;
  semanticSearchEnabled: boolean;
  semanticSearchMode: "off" | "auto";
  semanticStatus: "disabled" | SemanticSearchRuntimeStatus;
  embeddingProvider: "local" | "remote";
  /** The runtime the local embedder embedded with in this run; absent for a remote provider or when nothing was embedded locally. */
  embeddingRuntime?: "onnxruntime-node";
  entryCount: number;
  embeddingCount: number;
}

/** The `index_meta` key holding the last index run's {@link SemanticSearchRecord}. */
export const SEMANTIC_SEARCH_META_KEY = "semanticSearch";

/**
 * What the last index run found about semantic search, kept beside `hasEmbeddings`
 * for `akm health`'s `semantic-search` check. A record, not a gate: search never
 * reads it (#873). `unavailable` is a `blocked` run whose local embedding runtime
 * could not load on this machine.
 */
export interface SemanticSearchRecord {
  status: IndexVerification["semanticStatus"] | "unavailable";
  /** For `unavailable`: `platform` when akm offers no local embeddings on this platform, `load` when it does and the runtime could not be fetched or did not load. */
  unavailable?: "platform" | "load";
  provider: IndexVerification["embeddingProvider"];
  /** The runtime the local embedder embedded with in that run; absent when it embedded nothing. */
  runtime?: string;
  /** Why semantic search is blocked or unavailable. */
  reason?: string;
}

/** A configured source `akm index` could not scan completely: its last-known-good rows were kept. */
export interface IncompleteIndexSource {
  /** The bundle's id. */
  bundle: string;
  path: string;
  /** The filesystem error that stopped the scan, or why the source could not be scanned. */
  reason: string;
}

/** The `index_meta` key holding the {@link IncompleteIndexSource} list of the last index run. */
export const INCOMPLETE_SOURCES_META_KEY = "incompleteSources";

/**
 * The sources the last index run could not scan, whose last-known-good rows the index still serves. Undefined when
 * no run recorded the list (an index built before it was recorded).
 */
export function readIncompleteSources(db: Parameters<typeof getMeta>[0]): IncompleteIndexSource[] | undefined {
  const raw = getMeta(db, INCOMPLETE_SOURCES_META_KEY);
  return raw ? (JSON.parse(raw) as IncompleteIndexSource[]) : undefined;
}

/** The last index run's {@link SemanticSearchRecord} in an open index, or undefined when no run recorded one. */
export function readSemanticSearchRecord(db: Parameters<typeof getMeta>[0]): SemanticSearchRecord | undefined {
  const raw = getMeta(db, SEMANTIC_SEARCH_META_KEY);
  return raw ? (JSON.parse(raw) as SemanticSearchRecord) : undefined;
}

/** What `akm info` and `akm bundle update` report about semantic search: the recorded status, or why none can be reported. */
export type SemanticSearchStatus = SemanticSearchRecord["status"] | "pending" | "unknown";

/** Canonical configured owner that disappeared or moved since the last complete scan. */
export interface RemovedIndexSource {
  bundleId: string;
  sourceRoot: string;
  /** False when the same bundle id remains configured at a different root. */
  removeBundleEntries: boolean;
}
