// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedding profile: the text an embedding model expects around a query and
 * around a document. Retrieval models are trained with these prompts, and
 * sending raw text costs recall — Qwen3-Embedding without its query
 * instruction lost 0.096 nDCG@10 on the retrieval suite.
 *
 * Presets are matched on the model name; `embedding.queryTemplate` and
 * `embedding.documentTemplate` override them (an empty string means none).
 * `{text}` marks where the text goes; a template without it is a prefix.
 */

import { createHash } from "node:crypto";
import type { EmbeddingConnectionConfig } from "../../core/config/config";
import { isDeterministicEmbedEnabled } from "./deterministic";
import { DEFAULT_LOCAL_MODEL } from "./local";

export interface EmbeddingProfile {
  queryTemplate?: string;
  documentTemplate?: string;
}

const RETRIEVAL_QUERY_PREFIX = "Represent this sentence for searching relevant passages: {text}";

const PRESETS: ReadonlyArray<{ model: RegExp; profile: EmbeddingProfile }> = [
  {
    model: /qwen3-embedding/i,
    profile: {
      queryTemplate:
        "Instruct: Given a question or task, retrieve the knowledge asset that helps with it\nQuery:{text}",
    },
  },
  {
    model: /nomic-embed/i,
    profile: { queryTemplate: "search_query: {text}", documentTemplate: "search_document: {text}" },
  },
  {
    model: /bge-(?:small|base|large)-en|mxbai-embed|arctic-embed/i,
    profile: { queryTemplate: RETRIEVAL_QUERY_PREFIX },
  },
  {
    model: /(?:^|[^a-z0-9])e5-(?:small|base|large)(?!.*instruct)/i,
    profile: { queryTemplate: "query: {text}", documentTemplate: "passage: {text}" },
  },
];

/** The model a config embeds with, as the presets match it. */
function embeddingModelName(config: EmbeddingConnectionConfig | undefined): string {
  if (config?.endpoint) return config.model ?? "";
  return config?.localModel ?? DEFAULT_LOCAL_MODEL;
}

/** The configured model's templates: its preset, with each side replaced by an explicit config value. */
export function resolveEmbeddingProfile(config: EmbeddingConnectionConfig | undefined): EmbeddingProfile {
  const model = embeddingModelName(config);
  const preset = isDeterministicEmbedEnabled() ? {} : (PRESETS.find((entry) => entry.model.test(model))?.profile ?? {});
  const queryTemplate = config?.queryTemplate ?? preset.queryTemplate;
  const documentTemplate = config?.documentTemplate ?? preset.documentTemplate;
  return {
    ...(queryTemplate ? { queryTemplate } : {}),
    ...(documentTemplate ? { documentTemplate } : {}),
  };
}

/** Put `text` into `template`; no template returns the text unchanged. */
export function applyEmbeddingTemplate(template: string | undefined, text: string): string {
  if (!template) return text;
  // A replacer function keeps `$&`-style sequences in the text literal.
  return template.includes("{text}") ? template.replaceAll("{text}", () => text) : `${template}${text}`;
}

/**
 * The document template's part of the embedding fingerprint: empty without a
 * template, so vectors embedded without one stay current.
 */
export function documentTemplateFingerprint(config: EmbeddingConnectionConfig | undefined): string {
  const template = resolveEmbeddingProfile(config).documentTemplate;
  if (!template) return "";
  return `|doc:${createHash("sha256").update(template).digest("hex").slice(0, 12)}`;
}
