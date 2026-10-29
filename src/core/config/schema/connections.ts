// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `connections`: the OpenAI-compatible endpoints akm reaches models through.
 *
 * akm owns `endpoint`, `apiKey`, `models`, `contextLength`, `timeoutMs` and
 * `concurrency` (and keeps the retired `apiKeyFile` as written, never reading it). Every other key on a connection, or on a model entry, is a
 * request field in the endpoint's own spelling and is sent with each request as
 * written: the connection's fields apply to all its models, a model entry's
 * override them.
 */
import { z } from "zod";
import { WORKFLOW_MAX_TIMEOUT_MS } from "../../../workflows/resource-limits";
import {
  connectionEndpoint,
  engineName,
  envReferenceApiKey,
  nonEmptyString,
  OpaqueFieldSchema,
  positiveInt,
  retiredApiKeyFile,
} from "./primitives";

/**
 * Timeouts share the workflow ceiling: a larger value would pass config
 * validation and then fail every run with an unlocated "invocation is invalid".
 * `null` runs unbounded.
 */
export const timeoutMsField = z.union([positiveInt.max(WORKFLOW_MAX_TIMEOUT_MS), z.null()]).optional();

/**
 * One alias's target: the model's name, or an object holding it together with
 * request fields of its own. The object is listed first so a JSON value given to
 * `akm config set` is read as one.
 */
export const ModelEntrySchema = z.union([
  z.object({ model: nonEmptyString }).catchall(OpaqueFieldSchema),
  nonEmptyString,
]);

/** Alias (`fast`, `balanced`, `reasoning`, or any the user adds) to the model it names. */
export const ModelAliasesSchema = z.record(nonEmptyString, ModelEntrySchema);

export const ConnectionSchema = z
  .object({
    endpoint: connectionEndpoint,
    apiKey: envReferenceApiKey.optional(),
    apiKeyFile: retiredApiKeyFile.optional(),
    models: ModelAliasesSchema.optional(),
    contextLength: positiveInt.optional(),
    timeoutMs: timeoutMsField,
    concurrency: positiveInt.optional(),
  })
  .catchall(OpaqueFieldSchema);

export const ConnectionsSchema = z.record(engineName, ConnectionSchema);
