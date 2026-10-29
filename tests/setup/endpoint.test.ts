// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { endpointProblem, normalizeEndpoint } from "../../src/setup/endpoint";

describe("normalizeEndpoint", () => {
  test("stores the OpenAI-compatible base URL, whatever form the user typed", () => {
    expect(normalizeEndpoint("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeEndpoint("http://localhost:11434/")).toBe("http://localhost:11434/v1");
    expect(normalizeEndpoint("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeEndpoint("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
  });

  test("leaves a path that already names its API root alone", () => {
    expect(normalizeEndpoint("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
  });

  test("refuses what cannot be an endpoint, and says why", () => {
    expect(() => normalizeEndpoint("localhost:11434")).toThrow("http or https");
    expect(() => normalizeEndpoint("not a url")).toThrow("complete URL");
    expect(() => normalizeEndpoint("ftp://host/v1")).toThrow("http or https");
    expect(() => normalizeEndpoint("https://user:secret@host/v1")).toThrow("credentials");
    expect(() => normalizeEndpoint("https://host/v1?key=secret")).toThrow("credentials, query, or fragment");
  });

  test("as a prompt validator it returns the problem, or nothing", () => {
    expect(endpointProblem("http://localhost:1234")).toBeUndefined();
    expect(endpointProblem("nope")).toContain("complete URL");
  });
});
