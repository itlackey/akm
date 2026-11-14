// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Properties of the endpoint and ref normalizers over a small generated grid:
// normalizing twice is normalizing once, an operation URL names the same base as
// the base itself, and a parsed ref formats back to the ref it came from.

import { describe, expect, test } from "bun:test";
import { bundleRefToString, parseBundleRef } from "../../src/core/asset/asset-ref";
import { openAiBaseUrl, sameEndpoint } from "../../src/core/endpoint-url";
import { normalizeEndpoint } from "../../src/setup/endpoint";

const hosts = ["http://localhost:11434", "https://api.example.com", "http://10.0.0.5:8080"];
const bases = ["", "/v1", "/V1", "/openai/v1", "/api/v1", "/v1beta/openai", "/gateway/v1"];
const operations = ["models", "embeddings", "chat/completions", "completions", "Models", "CHAT/COMPLETIONS"];
const slashes = ["", "/"];

describe("endpoint normalization properties", () => {
  test("normalizing twice is normalizing once", () => {
    for (const host of hosts)
      for (const base of bases)
        for (const op of ["", ...operations])
          for (const slash of slashes) {
            const typed = `${host}${base}${op ? `/${op}` : ""}${slash}`;
            const once = normalizeEndpoint(typed);
            expect(normalizeEndpoint(once)).toBe(once);
            expect(openAiBaseUrl(openAiBaseUrl(typed))).toBe(openAiBaseUrl(typed));
          }
  });

  test("an operation URL normalizes to its base, and is the same endpoint as it", () => {
    for (const host of hosts)
      for (const base of bases)
        for (const op of operations)
          for (const slash of slashes) {
            const withOp = `${host}${base}/${op}${slash}`;
            expect(normalizeEndpoint(withOp)).toBe(normalizeEndpoint(`${host}${base}`));
            expect(sameEndpoint(withOp, `${host}${base}`)).toBe(true);
          }
  });

  test("the OpenAI-compatible root is never extended by a second /v1", () => {
    for (const host of hosts)
      for (const root of ["/v1", "/V1", "/openai/v1", "/v1beta/openai"])
        for (const op of ["", ...operations]) {
          const stored = normalizeEndpoint(`${host}${root}${op ? `/${op}` : ""}`);
          expect(stored.toLowerCase()).toBe(`${host}${root}`.toLowerCase());
        }
  });
});

describe("ref round-trip properties", () => {
  const bundles = [undefined, "team", "akm-core"];
  const conceptIds = ["knowledge/guide", "skills/review/SKILL", "scripts/deploy.sh", "memories/a-b_c"];
  const fragments = [undefined, "intro", "akm-fragment-1-abc"];

  test("formatting a parsed ref and parsing it again yields the same ref", () => {
    for (const bundle of bundles)
      for (const conceptId of conceptIds)
        for (const fragment of fragments) {
          const typed = `${bundle ? `${bundle}//` : ""}${conceptId}${fragment ? `#${fragment}` : ""}`;
          const parsed = parseBundleRef(typed);
          expect(parseBundleRef(bundleRefToString(parsed))).toEqual(parsed);
        }
  });
});
