// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embeddings in Settings: the `embedding` config block as a draft, and a draft back to the config keys `akm setup`
 * writes for the same choice. Desktop checks only what a form can say before sending; akm's config schema decides what
 * is accepted. Keys Desktop has no control for (batch size, templates, timeouts, …) are never touched.
 */

export type EmbeddingSource = "local" | "connection" | "endpoint";
export interface EmbeddingBlock {
  endpoint?: string;
  model?: string;
  apiKey?: string;
  dimension?: number;
  [key: string]: unknown;
}
export interface EmbeddingDraft {
  source: EmbeddingSource;
  model: string;
  endpoint: string;
  /** A `$VAR` reference, or a key to store: always what was typed now, never what is held. */
  apiKey: string;
  dimension: string;
}
export interface EmbeddingChange {
  set: Record<string, string>;
  unset: string[];
  /** A typed key, to store for the endpoint in `credentials.json`. */
  key?: { key: string; endpoint: string };
}

/** An endpoint says the endpoint choice, a model alone says the default connection, neither the built-in embedder. */
export function embeddingSource(block: EmbeddingBlock | undefined): EmbeddingSource {
  return block?.endpoint ? "endpoint" : block?.model ? "connection" : "local";
}

export function embeddingDraft(block: EmbeddingBlock | undefined): EmbeddingDraft {
  return {
    source: embeddingSource(block),
    model: block?.model ?? "",
    endpoint: block?.endpoint ?? "",
    apiKey: "",
    dimension: block?.dimension === undefined ? "" : String(block.dimension),
  };
}

const whole = (text: string) => /^[0-9]+$/.test(text.trim()) && Number(text) > 0;

/** What stops a draft being sent, by field: `model`, `endpoint`, `dimension`. */
export function embeddingErrors(draft: EmbeddingDraft, { hasConnection }: { hasConnection: boolean }) {
  const errors: Record<string, string> = {};
  if (draft.source === "local") return errors;
  if (!draft.model.trim()) errors.model = "Enter the embedding model's name.";
  if (draft.source === "connection" && !hasConnection)
    errors.model = "No default connection serves this model. Add one under Connections, or choose a remote endpoint.";
  if (draft.source === "endpoint") {
    try {
      if (!/^https?:$/.test(new URL(draft.endpoint.trim()).protocol)) throw new Error("scheme");
    } catch {
      errors.endpoint = "Enter a complete http or https URL.";
    }
  }
  if (draft.dimension.trim() && !whole(draft.dimension)) errors.dimension = "Enter a whole number above 0.";
  return errors;
}

/**
 * The vectors' identity: the model and dimension they were made under, as akm records it (the endpoint is not part of
 * it). Different fingerprints mean the next index run embeds every entry again.
 */
const fingerprint = (draft: EmbeddingDraft) =>
  draft.source === "local" ? "local" : `${draft.model.trim()}|${draft.dimension.trim()}`;
export const reembeds = (draft: EmbeddingDraft, base: EmbeddingDraft) => fingerprint(draft) !== fingerprint(base);

export function embeddingChanges(draft: EmbeddingDraft, base: EmbeddingDraft): number {
  return (["source", "model", "endpoint", "apiKey", "dimension"] as const).filter((key) => draft[key] !== base[key])
    .length;
}

/**
 * The config keys to write for a draft, over the block as loaded. Only what the choice owns is written or removed:
 * the built-in embedder drops the endpoint, model and key; the default connection's model drops the endpoint and key;
 * a remote endpoint's key belongs to that endpoint, so a new endpoint without a key drops the old reference.
 * `mode` is the current `semanticSearchMode`: choosing an embedder turns semantic search on, as setup does.
 */
export function embeddingChange(
  draft: EmbeddingDraft,
  base: EmbeddingDraft,
  original: EmbeddingBlock | undefined,
  mode: string,
): EmbeddingChange {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  const held = (key: string) => original !== undefined && original[key] !== undefined;
  const put = (key: string, value: string, was: string) => {
    if (value !== was || !held(key)) set[`embedding.${key}`] = value;
  };
  const drop = (key: string) => {
    if (held(key)) unset.push(`embedding.${key}`);
  };
  const model = draft.model.trim();
  const endpoint = draft.endpoint.trim();
  const typed = draft.apiKey.trim();
  let key: EmbeddingChange["key"];
  if (draft.source === "local") {
    for (const name of ["endpoint", "model", "apiKey"]) drop(name);
  } else {
    put("model", model, base.model);
    if (draft.dimension.trim()) put("dimension", draft.dimension.trim(), base.dimension);
    else drop("dimension");
    if (draft.source === "connection") {
      drop("endpoint");
      drop("apiKey");
    } else {
      put("endpoint", endpoint, base.endpoint);
      if (typed.startsWith("$")) set["embedding.apiKey"] = typed;
      else if (typed) {
        // A key to store is read from `credentials.json` only while the block has no reference of its own.
        key = { key: typed, endpoint };
        drop("apiKey");
      } else if (endpoint !== base.endpoint) drop("apiKey");
    }
  }
  if (embeddingChanges(draft, base) && mode !== "auto") set.semanticSearchMode = "auto";
  return { set, unset, ...(key ? { key } : {}) };
}

/** What the form says about the key: the reference the block names, else the endpoint a stored key belongs to. Never the key. */
export function keyStatus(
  original: EmbeddingBlock | undefined,
  storedFor: string | null,
  draft: EmbeddingDraft,
  base: EmbeddingDraft,
): string {
  const held = original?.apiKey
    ? `Reading the key from ${original.apiKey}.`
    : storedFor
      ? `A key is stored for ${storedFor}.`
      : "No key is set.";
  return base.source === "endpoint" && draft.endpoint.trim() !== base.endpoint
    ? `${held} A key belongs to the endpoint it was given for, so enter one for the new endpoint.`
    : held;
}
