// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup step 4: embeddings. A model the connection serves, akm's built-in local
 * embedder, another endpoint, or off (which is semantic search off).
 */

import * as p from "../../cli/clack";
import { type AkmConfig, defaultConnection, type EmbeddingConnectionConfig } from "../../core/config/config";
import { resolveApiKey } from "../../core/config/credentials";
import { sameEndpoint } from "../../core/endpoint-url";
import { UsageError } from "../../core/errors";
import { isEmbeddingModel } from "../../llm/model-list";
import { prompt } from "../prompt";
import { describeSemanticSearchAssets, isRemoteEmbeddingConfig } from "../semantic-assets";
import type { SetupFlags } from "../setup-flags";
import type { ConnectionAnswer, EmbeddingAnswer, KeyAnswer } from "../setup-plan";
import { listModels, pickModel, promptApiKey, promptEndpoint, promptModelName } from "./connection-shared";

export interface SemanticSearchChoice {
  mode: "off" | "auto";
  prepareAssets: boolean;
}

export interface EmbeddingStepInput {
  current: AkmConfig;
  flags: SetupFlags;
  interactive: boolean;
  probe: boolean;
  /** What the connection step decided, and the models its endpoint listed. */
  connection?: ConnectionAnswer;
  listed: readonly string[];
  /** This run added the connection that is now the default. */
  addedDefaultConnection: boolean;
}

export interface EmbeddingStepResult {
  /** Absent: the embedding config stays as it is. */
  answer?: EmbeddingAnswer;
  semantic: SemanticSearchChoice;
}

/** The base URL of the connection that would serve an embedding model, once this run's connection is saved. */
function servingEndpoint(input: EmbeddingStepInput): string | undefined {
  return input.connection?.endpoint ?? defaultConnection(input.current)?.connection.endpoint;
}

function fromFlags(input: EmbeddingStepInput): EmbeddingAnswer {
  const { flags } = input;
  if (flags.embedding === "off" || flags.embedding === "local") return { kind: flags.embedding };
  const model = flags.embedding as string;
  if (flags.embeddingEndpoint !== undefined) {
    return {
      kind: "endpoint",
      endpoint: flags.embeddingEndpoint,
      model,
      ...(flags.embeddingApiKeyEnv ? { key: { env: flags.embeddingApiKeyEnv } } : {}),
    };
  }
  if (servingEndpoint(input) === undefined) {
    throw new UsageError(
      `--embedding ${model} is served by the default connection, and none is configured. Pass --endpoint (or --embedding-endpoint).`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  return { kind: "connection", model };
}

/** The embedding block this answer leaves the config with, for the note that says what setup downloads. */
function embeddingAfter(input: EmbeddingStepInput, answer: EmbeddingAnswer): EmbeddingConnectionConfig | undefined {
  if (answer.kind === "endpoint") return { endpoint: answer.endpoint, model: answer.model };
  if (answer.kind === "connection") return { endpoint: servingEndpoint(input), model: answer.model };
  return answer.kind === "off" ? input.current.embedding : undefined;
}

async function askSource(input: EmbeddingStepInput): Promise<EmbeddingAnswer> {
  const { current } = input;
  const servedModels = input.listed.filter(isEmbeddingModel);
  const heldModel = current.embedding?.endpoint === undefined ? current.embedding?.model : undefined;
  const connectionModels = [...new Set([...(heldModel ? [heldModel] : []), ...servedModels])];

  const options = [
    ...connectionModels.map((model) => ({ value: `model:${model}`, label: model, hint: "served by the connection" })),
    { value: "local", label: "Built-in local embedder", hint: "no server needed" },
    { value: "endpoint", label: "Another endpoint" },
    { value: "off", label: "Off", hint: "keyword search only" },
  ];
  const initialValue = current.embedding?.endpoint
    ? "endpoint"
    : heldModel
      ? `model:${heldModel}`
      : servedModels[0]
        ? `model:${servedModels[0]}`
        : "local";
  const choice = await prompt(() =>
    p.select({ message: "Which embedding source should akm use?", options, initialValue }),
  );

  if (choice === "local" || choice === "off") return { kind: choice };
  if (choice !== "endpoint") return { kind: "connection", model: choice.slice("model:".length) };

  const endpoint = await promptEndpoint({
    message: "Embedding endpoint URL:",
    ...(current.embedding?.endpoint ? { initialValue: current.embedding.endpoint } : {}),
  });
  if (endpoint === undefined) return { kind: "local" };
  const held = resolveApiKey(current.embedding?.apiKey, "embedding", process.env, true);
  const typed = await promptApiKey(
    held !== undefined ? "Embedding API key (blank keeps the current one)" : "Embedding API key (blank for none)",
  );
  const key: KeyAnswer | undefined = typed ? { pasted: typed } : undefined;

  // The held key is sent only to the endpoint it belongs to.
  const unchangedEndpoint =
    current.embedding?.endpoint !== undefined && sameEndpoint(current.embedding.endpoint, endpoint);
  const listed = input.probe ? await listModels(endpoint, typed ?? (unchangedEndpoint ? held : undefined), true) : [];
  const embeddingModels = listed.filter(isEmbeddingModel);
  const model =
    listed.length > 0
      ? await pickModel(
          "Embedding model:",
          embeddingModels.length > 0 ? embeddingModels : listed,
          current.embedding?.model,
        )
      : await promptModelName({ message: "Embedding model name:", initialValue: current.embedding?.model });
  return { kind: "endpoint", endpoint, model, ...(key ? { key } : {}) };
}

export async function stepEmbeddings(input: EmbeddingStepInput): Promise<EmbeddingStepResult> {
  const { current, flags, interactive } = input;
  const unchanged: SemanticSearchChoice = { mode: current.semanticSearchMode, prepareAssets: false };

  if (flags.embedding !== undefined) {
    const answer = fromFlags(input);
    return { answer, semantic: { mode: answer.kind === "off" ? "off" : "auto", prepareAssets: false } };
  }

  if (!interactive) {
    // The default: a model the new default connection serves. A rerun, another connection, or an embedding
    // block the config already has is the user's earlier choice and stays.
    const model = input.listed.find(isEmbeddingModel);
    if (model === undefined || current.embedding !== undefined || !input.addedDefaultConnection) {
      return { semantic: unchanged };
    }
    return { answer: { kind: "connection", model }, semantic: { mode: "auto", prepareAssets: false } };
  }

  const answer = await askSource(input);
  if (answer.kind === "off") return { answer, semantic: { mode: "off", prepareAssets: false } };

  const after = embeddingAfter(input, answer);
  p.note(describeSemanticSearchAssets(after).join("\n"), "Semantic Search Assets");
  const prepareAssets = await prompt(() =>
    p.confirm({
      message: isRemoteEmbeddingConfig(after)
        ? "Check the embedding endpoint and verify semantic search now?"
        : "Download and verify semantic-search assets now?",
      initialValue: true,
    }),
  );
  return { answer, semantic: { mode: "auto", prepareAssets } };
}
