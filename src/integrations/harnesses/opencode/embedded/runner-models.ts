// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The models akm's runtime runs, declared as they are dispatched.
 *
 * A dispatch carries the connection it was frozen with: endpoint, model, window
 * and output cap. The runtime host reads no config, so it declares no provider
 * of its own: each connection a run brings gets one, named for what makes it
 * distinct (endpoint, model, window, cap) and added through the akm plugin's
 * provider transform when the run asks for it. Two runs of one connection name
 * that froze different endpoints are two providers on the one host, and a run
 * never reaches an endpoint its connection did not name.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin";
import { openAiBaseUrl } from "../../../../core/endpoint-url";
import { effectiveRequestFields } from "../../../../core/llm-inference";
import type { ChatCompletionConfig } from "../../../../llm/client";

/** The model a dispatched connection runs, and the provider that carries it. */
export interface RunnerModel {
  readonly providerID: string;
  readonly modelID: string;
  /** The connection's OpenAI-compatible base URL. */
  readonly baseURL: string;
  /** The connection's window, when it says; OpenCode's own assumption otherwise. */
  readonly context?: number;
  /** The output cap the connection asks for, when it does; this is the model's declared limit, never a default akm invents. */
  readonly output?: number;
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** The model and provider that `connection` runs as. The provider id is derived from everything the declaration holds. */
export function runnerModel(connection: ChatCompletionConfig): RunnerModel {
  const context = positiveInteger(connection.contextLength);
  const output = positiveInteger(effectiveRequestFields(connection.request, connection.inference).max_tokens);
  const identity = JSON.stringify([connection.endpoint, connection.model, context ?? null, output ?? null]);
  return {
    providerID: `akm-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    modelID: connection.model,
    baseURL: openAiBaseUrl(connection.endpoint),
    ...(context !== undefined ? { context } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

/**
 * The AI SDK package an OpenAI-compatible endpoint is reached with, as OpenCode
 * names it. OpenCode loads a `file://` package as it is and installs any other
 * from the npm registry on first use, so it is given a copy that is already here:
 * the one installed with akm, or, in a compiled akm binary, the copy the build
 * embeds beside the main module (`scripts/ai-sdk-openai-compatible.ts`).
 */
const OPENAI_COMPATIBLE_PACKAGE = (() => {
  for (const specifier of ["@ai-sdk/openai-compatible", "./ai-sdk-openai-compatible.js"]) {
    try {
      const url = import.meta.resolve(specifier);
      if (url.startsWith("file://") && fs.existsSync(fileURLToPath(url))) return `aisdk:${url}`;
    } catch {
      // Not installed, not embedded: the next place.
    }
  }
  return "aisdk:@ai-sdk/openai-compatible";
})();

/** OpenCode's own assumptions for a model that states no limit. */
const DEFAULT_LIMIT = { context: 200_000, output: 32_000 };

function providerInfo({ providerID, baseURL }: RunnerModel): never {
  return {
    id: providerID,
    name: providerID,
    activation: "enabled",
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: { baseURL },
  } as never;
}

function modelInfo({ providerID, modelID, context, output }: RunnerModel): never {
  return {
    id: modelID,
    modelID,
    providerID,
    name: modelID,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: context ?? DEFAULT_LIMIT.context, output: output ?? DEFAULT_LIMIT.output },
  } as never;
}

/** One place the host's OpenCode is set up for: it holds the declarations that place has read, and how to read them again. */
interface Location {
  readonly declared: Set<string>;
  readonly reload: () => Promise<void>;
}

/**
 * The runner models declared on one runtime host. A model is declared once and
 * stays declared for the life of the host, so a run in flight is never affected
 * by another run's declaration.
 */
export class RunnerModels {
  private readonly models = new Map<string, RunnerModel>();
  private readonly locations = new Set<Location>();

  /** Declare `model` where the host's OpenCode is already set up; a place set up later reads it then. */
  async declare(model: RunnerModel): Promise<void> {
    this.models.set(model.providerID, model);
    for (const location of this.locations) {
      if (!location.declared.has(model.providerID)) await location.reload();
    }
  }

  /** Called as OpenCode sets the akm plugin up for a place: it declares every model so far, and again on each reload. */
  async attach(provider: Plugin.Context["provider"]): Promise<() => void> {
    const location: Location = { declared: new Set(), reload: () => provider.reload() };
    await provider.transform((editor) => {
      for (const model of this.models.values()) {
        editor.add({ info: providerInfo(model), models: [modelInfo(model)] });
        location.declared.add(model.providerID);
      }
    });
    this.locations.add(location);
    return () => {
      this.locations.delete(location);
    };
  }
}
