// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The flags of `akm setup` that answer its questions, checked once before
 * setup prompts, contacts anything or writes. A flag answers its question; a
 * question no flag answers is asked, or, under `--yes`, takes the detected
 * default.
 */
import { ENGINE_NAME_PATTERN_SOURCE } from "../core/config/engine-semantics";
import { UsageError } from "../core/errors";
import { HARNESS_CONFIG_PLATFORMS } from "../integrations/harnesses";
import { normalizeEndpoint } from "./endpoint";

/** The flags as the command line gives them. */
export interface RawEngineFlags {
  endpoint?: string;
  apiKeyEnv?: string;
  name?: string;
  harness?: string;
  embedding?: string;
  embeddingEndpoint?: string;
  embeddingApiKeyEnv?: string;
}

/** The flags, checked. */
export interface EngineFlags {
  /** The connection's endpoint, as its base URL. */
  endpoint?: string;
  /** The variable holding the connection's key. */
  apiKeyEnv?: string;
  /** The connection to add or update, when not the default one. */
  name?: string;
  /** Platforms to enable; the first is the default harness. */
  harness?: string[];
  /** An embedding model, or `local` (the built-in embedder), or `off`. */
  embedding?: string;
  /** Another endpoint serving the embedding model, as its base URL. */
  embeddingEndpoint?: string;
  embeddingApiKeyEnv?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME = new RegExp(ENGINE_NAME_PATTERN_SOURCE);

function bad(flag: string, problem: string): never {
  throw new UsageError(`--${flag}: ${problem}`, "INVALID_FLAG_VALUE");
}

function endpointFlag(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeEndpoint(value);
  } catch (err) {
    return bad(flag, err instanceof Error ? err.message : String(err));
  }
}

function envNameFlag(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ENV_NAME.test(value)) bad(flag, "name the environment variable that holds the key, not the key itself");
  return value;
}

export function parseEngineFlags(raw: RawEngineFlags): EngineFlags {
  const endpoint = endpointFlag("endpoint", raw.endpoint);
  const embeddingEndpoint = endpointFlag("embedding-endpoint", raw.embeddingEndpoint);
  const apiKeyEnv = envNameFlag("api-key-env", raw.apiKeyEnv);
  const embeddingApiKeyEnv = envNameFlag("embedding-api-key-env", raw.embeddingApiKeyEnv);

  if (raw.name !== undefined && !NAME.test(raw.name)) {
    bad("name", "use lowercase kebab-case, not beginning with akm-");
  }

  let harness: string[] | undefined;
  if (raw.harness !== undefined) {
    harness = raw.harness
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const unknown = harness.filter((platform) => !(HARNESS_CONFIG_PLATFORMS as readonly string[]).includes(platform));
    if (harness.length === 0 || unknown.length > 0) {
      bad(
        "harness",
        `${unknown.length > 0 ? `unknown platform ${unknown.join(", ")}; ` : ""}use a comma-separated list of ${HARNESS_CONFIG_PLATFORMS.join(", ")}`,
      );
    }
  }

  const embedding = raw.embedding?.trim();
  if (raw.embedding !== undefined && !embedding) bad("embedding", "name a model, or local, or off");
  if (embeddingEndpoint !== undefined && (embedding === undefined || embedding === "local" || embedding === "off")) {
    bad("embedding-endpoint", "needs --embedding <model>, the model that endpoint serves");
  }
  if (embeddingApiKeyEnv !== undefined && embeddingEndpoint === undefined) {
    bad("embedding-api-key-env", "needs --embedding-endpoint; an embedding model on the connection uses its key");
  }

  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
    ...(embeddingEndpoint !== undefined ? { embeddingEndpoint } : {}),
    ...(embeddingApiKeyEnv !== undefined ? { embeddingApiKeyEnv } : {}),
  };
}

/** Whether any flag answers a question. */
export function hasEngineFlags(flags: EngineFlags): boolean {
  return Object.keys(flags).length > 0;
}
