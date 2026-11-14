// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embeddings in Settings: the `embedding` config block as a draft, and a draft as the answer akm's setup takes.
 * akm decides what the answer writes (the block, the endpoint's form, where a key goes); Desktop checks only what a
 * form can say before sending.
 */

export type EmbeddingSource = "local" | "connection" | "endpoint";
export interface EmbeddingBlock {
  endpoint?: string;
  model?: string;
  apiKey?: string;
  [key: string]: unknown;
}
export interface EmbeddingDraft {
  source: EmbeddingSource;
  model: string;
  endpoint: string;
  /** A `$VAR` reference, or a key to store: always what was typed now, never what is held. */
  apiKey: string;
}
/** The body of `config.saveEmbedding`. */
export interface EmbeddingAnswer {
  kind: EmbeddingSource;
  model?: string;
  endpoint?: string;
  key?: { env: string } | { pasted: string };
}

/** An endpoint says the endpoint choice, a model alone says the default connection, neither the built-in embedder. */
export function embeddingSource(block: EmbeddingBlock | undefined): EmbeddingSource {
  return block?.endpoint ? "endpoint" : block?.model ? "connection" : "local";
}

export function embeddingDraft(block: EmbeddingBlock | undefined): EmbeddingDraft {
  return { source: embeddingSource(block), model: block?.model ?? "", endpoint: block?.endpoint ?? "", apiKey: "" };
}

/** What stops a draft being sent, by field: `model`, `endpoint`. */
export function embeddingErrors(draft: EmbeddingDraft, { hasConnection }: { hasConnection: boolean }) {
  const errors: Record<string, string> = {};
  if (draft.source === "local") return errors;
  if (!draft.model.trim()) errors.model = "Enter the embedding model's name.";
  else if (draft.source === "connection" && !hasConnection)
    errors.model = "No default connection serves this model. Add one under Connections, or choose a remote endpoint.";
  if (draft.source === "endpoint") {
    try {
      if (!/^https?:$/.test(new URL(draft.endpoint.trim()).protocol)) throw new Error("scheme");
    } catch {
      errors.endpoint = "Enter a complete http or https URL.";
    }
  }
  return errors;
}

/** A `$VAR` is the variable's name; any other text is the key. No text sends no key, so akm keeps the one for the same endpoint. */
export function embeddingAnswer(draft: EmbeddingDraft): EmbeddingAnswer {
  if (draft.source === "local") return { kind: "local" };
  const model = draft.model.trim();
  if (draft.source === "connection") return { kind: "connection", model };
  const typed = draft.apiKey.trim();
  return {
    kind: "endpoint",
    endpoint: draft.endpoint.trim(),
    model,
    ...(typed ? { key: typed.startsWith("$") ? { env: typed.slice(1) } : { pasted: typed } } : {}),
  };
}

/** The vectors' identity is the model they were made with: another model, or local against remote, embeds every entry again. */
const fingerprint = (draft: EmbeddingDraft) => (draft.source === "local" ? "" : draft.model.trim());
export const reembeds = (draft: EmbeddingDraft, base: EmbeddingDraft) => fingerprint(draft) !== fingerprint(base);

export function embeddingChanges(draft: EmbeddingDraft, base: EmbeddingDraft): number {
  return (["source", "model", "endpoint", "apiKey"] as const).filter((key) => draft[key] !== base[key]).length;
}

/** The keys of the block that choosing the built-in embedder would remove along with it: the ones Desktop does not show. */
export const tuningKeys = (block: EmbeddingBlock | undefined): string[] =>
  Object.keys(block ?? {}).filter((key) => !["endpoint", "model", "apiKey"].includes(key));

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
