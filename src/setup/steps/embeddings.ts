// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup step 4: embeddings. A model the connection serves, akm's built-in local
 * embedder, another endpoint, or off (which is semantic search off).
 */

import * as p from "../../cli/clack";
import {
  type AkmConfig,
  type ConnectionConfig,
  defaultConnection,
  type EmbeddingConnectionConfig,
} from "../../core/config/config";
import { apiKeyReference, resolveApiKey, storedCredential } from "../../core/config/credentials";
import { sameEndpoint } from "../../core/endpoint-url";
import { UsageError } from "../../core/errors";
import { redactUrlCredentials } from "../../core/redaction";
import { isEmbeddingModel } from "../../llm/model-list";
import { prompt } from "../prompt";
import { describeSemanticSearchAssets, isRemoteEmbeddingConfig } from "../semantic-assets";
import type { SetupFlags } from "../setup-flags";
import { applySetupAnswers, type ConnectionAnswer, type EmbeddingAnswer, type KeyAnswer } from "../setup-plan";
import { listModels, pickModel, promptApiKey, promptEndpoint, promptModelName, warnUser } from "./connection-shared";

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

/**
 * The connection that will serve an embedding model once this run's answers are saved: the default connection
 * of the config as it will be, which is not necessarily the one this run just answered (a further `--name`
 * connection is not the default, and with several none of which is called `default` there is none).
 */
function servingConnection(input: EmbeddingStepInput): { name: string; connection: ConnectionConfig } | undefined {
  const projected: AkmConfig = input.connection
    ? { ...input.current, ...applySetupAnswers(input.current, { connection: input.connection }).patch }
    : input.current;
  return defaultConnection(projected);
}

/** The embedding models the serving connection lists: this run's listing, when this run was about that connection. */
function servedModels(input: EmbeddingStepInput): string[] {
  const serving = servingConnection(input);
  return serving !== undefined && input.connection?.name === serving.name ? input.listed.filter(isEmbeddingModel) : [];
}

/**
 * A key belongs to the endpoint it was given for. When the embedding endpoint changes and no
 * key comes with the new one, the current key is not carried over; say so.
 */
function warnOfDroppedKey(
  current: EmbeddingConnectionConfig | undefined,
  endpoint: string,
  keyGiven: boolean,
  interactive: boolean,
): void {
  if (keyGiven || current?.endpoint === undefined || sameEndpoint(current.endpoint, endpoint)) return;
  if (apiKeyReference(current.apiKey) === undefined && storedCredential({ service: "embedding" }) === undefined) return;
  warnUser(
    `The embedding endpoint changed, so its current key is not used with ${redactUrlCredentials(endpoint)}. Give the new endpoint's key with --embedding-api-key-env (or at the prompt).`,
    interactive,
  );
}

function fromFlags(input: EmbeddingStepInput): EmbeddingAnswer {
  const { flags } = input;
  if (flags.embedding === "off" || flags.embedding === "local") return { kind: flags.embedding };
  const model = flags.embedding as string;
  if (flags.embeddingEndpoint !== undefined) {
    warnOfDroppedKey(input.current.embedding, flags.embeddingEndpoint, Boolean(flags.embeddingApiKeyEnv), false);
    return {
      kind: "endpoint",
      endpoint: flags.embeddingEndpoint,
      model,
      ...(flags.embeddingApiKeyEnv ? { key: { env: flags.embeddingApiKeyEnv } } : {}),
    };
  }
  if (servingConnection(input) === undefined) {
    const several =
      Object.keys(
        input.connection
          ? { ...input.current.connections, [input.connection.name]: 1 }
          : (input.current.connections ?? {}),
      ).length > 1;
    throw new UsageError(
      several
        ? `--embedding ${model} is served by the default connection, and none of the connections is called "default". Name one default (akm setup --name default), or pass --embedding-endpoint.`
        : `--embedding ${model} is served by the default connection, and none is configured. Pass --endpoint (or --embedding-endpoint).`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  return { kind: "connection", model };
}

/** The embedding block this answer leaves the config with, for the note that says what setup downloads. */
function embeddingAfter(input: EmbeddingStepInput, answer: EmbeddingAnswer): EmbeddingConnectionConfig | undefined {
  if (answer.kind === "endpoint") return { endpoint: answer.endpoint, model: answer.model };
  if (answer.kind === "connection")
    return { endpoint: servingConnection(input)?.connection.endpoint, model: answer.model };
  return answer.kind === "off" ? input.current.embedding : undefined;
}

async function askSource(input: EmbeddingStepInput): Promise<EmbeddingAnswer> {
  const { current } = input;
  const served = servedModels(input);
  const hasServing = servingConnection(input) !== undefined;
  const heldModel = hasServing && current.embedding?.endpoint === undefined ? current.embedding?.model : undefined;
  const connectionModels = [...new Set([...(heldModel ? [heldModel] : []), ...served])];

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
      : served[0]
        ? `model:${served[0]}`
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
  // A key belongs to the endpoint it was given for, so the current one is offered for that endpoint alone.
  const unchangedEndpoint =
    current.embedding?.endpoint !== undefined && sameEndpoint(current.embedding.endpoint, endpoint);
  const held = unchangedEndpoint
    ? resolveApiKey(current.embedding?.apiKey, { service: "embedding" }, endpoint, process.env, true)
    : undefined;
  const typed = await promptApiKey(
    held !== undefined ? "Embedding API key (blank keeps the current one)" : "Embedding API key (blank for none)",
  );
  const key: KeyAnswer | undefined = typed ? { pasted: typed } : undefined;
  warnOfDroppedKey(current.embedding, endpoint, key !== undefined, true);

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
    const model = servedModels(input)[0];
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
