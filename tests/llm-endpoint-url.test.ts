// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// An endpoint with a query string (a gateway's `api-version`) is reached with the
// operation in the pathname and the query intact, by every consumer of an endpoint
// (mocked fetch: no server).

import { describe, expect, test } from "bun:test";
import { chatCompletion, probeLlmEndpoint } from "../src/llm/client";
import { listEndpointModels } from "../src/llm/model-list";
import { withMockedFetch } from "./_helpers/sandbox";

const QUERY = "?api-version=2026-01-01";
const endpoints = {
  base: `https://example.invalid/v1${QUERY}`,
  complete: `https://example.invalid/v1/chat/completions${QUERY}`,
  trailing: `https://example.invalid/v1/${QUERY}`,
};

function seen(run: () => Promise<unknown>): Promise<string[]> {
  const urls: string[] = [];
  return withMockedFetch(
    async () => {
      await run();
      return urls;
    },
    (url) => {
      urls.push(url);
      return Response.json({ choices: [{ message: { content: "ok" } }], data: [{ id: "m" }] });
    },
  );
}

describe("an endpoint with a query string", () => {
  for (const [spelling, endpoint] of Object.entries(endpoints)) {
    test(`chat completions go to the pathname, query intact (${spelling})`, async () => {
      expect(await seen(() => chatCompletion({ endpoint, model: "m" }, [{ role: "user", content: "hi" }]))).toEqual([
        `https://example.invalid/v1/chat/completions${QUERY}`,
      ]);
    });

    test(`model listing and the health probe go to /models, query intact (${spelling})`, async () => {
      expect(await seen(() => listEndpointModels({ endpoint }))).toEqual([`https://example.invalid/v1/models${QUERY}`]);
      expect(await seen(() => probeLlmEndpoint({ endpoint }))).toEqual([`https://example.invalid/v1/models${QUERY}`]);
    });
  }
});
