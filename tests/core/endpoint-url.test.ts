// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { openAiBaseUrl, openAiOperationUrl, sameEndpoint } from "../../src/core/endpoint-url";

describe("openAiBaseUrl", () => {
  test("is the endpoint without a trailing slash or /chat/completions", () => {
    expect(openAiBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(openAiBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
    expect(openAiBaseUrl("http://localhost:11434/v1/chat/completions")).toBe("http://localhost:11434/v1");
    expect(openAiBaseUrl("http://localhost:11434/v1/chat/completions/")).toBe("http://localhost:11434/v1");
  });

  test("keeps a bare host bare", () => {
    expect(openAiBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
    expect(openAiBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434");
  });

  test("edits only the pathname: the query stays after it, and the fragment, never sent, goes", () => {
    expect(openAiBaseUrl("https://example.invalid/v1/chat/completions?api-version=2026-01-01")).toBe(
      "https://example.invalid/v1?api-version=2026-01-01",
    );
    expect(openAiBaseUrl("https://example.invalid/v1/?api-version=2026-01-01#frag")).toBe(
      "https://example.invalid/v1?api-version=2026-01-01",
    );
  });

  test("keeps a username and password the endpoint carries", () => {
    expect(openAiBaseUrl("https://user:pw@example.invalid/v1/")).toBe("https://user:pw@example.invalid/v1");
  });
});

describe("openAiOperationUrl", () => {
  test("appends the operation to the pathname of a base or a complete chat URL", () => {
    expect(openAiOperationUrl("https://example.invalid/v1", "chat/completions")).toBe(
      "https://example.invalid/v1/chat/completions",
    );
    expect(openAiOperationUrl("https://example.invalid/v1/chat/completions", "chat/completions")).toBe(
      "https://example.invalid/v1/chat/completions",
    );
    expect(openAiOperationUrl("https://example.invalid/v1/chat/completions", "models")).toBe(
      "https://example.invalid/v1/models",
    );
    expect(openAiOperationUrl("http://localhost:11434", "models")).toBe("http://localhost:11434/models");
  });

  test("puts the operation in the pathname, never inside the query", () => {
    expect(
      openAiOperationUrl("https://example.invalid/v1/chat/completions?api-version=2026-01-01", "chat/completions"),
    ).toBe("https://example.invalid/v1/chat/completions?api-version=2026-01-01");
    expect(openAiOperationUrl("https://example.invalid/v1?api-version=2026-01-01", "models")).toBe(
      "https://example.invalid/v1/models?api-version=2026-01-01",
    );
    expect(openAiOperationUrl("https://example.invalid/v1/#frag", "models")).toBe("https://example.invalid/v1/models");
  });
});

describe("sameEndpoint", () => {
  test("is true however the same server is spelled", () => {
    expect(sameEndpoint("http://h:1/v1", "http://h:1/v1/chat/completions")).toBe(true);
    expect(sameEndpoint("http://h:1/v1/", "http://h:1/v1")).toBe(true);
  });

  test("is false for another server, path or query", () => {
    expect(sameEndpoint("http://h:1/v1", "http://h:2/v1")).toBe(false);
    expect(sameEndpoint("http://h:1/v1", "http://h:1/v2")).toBe(false);
    expect(sameEndpoint("http://h:1/v1?a=1", "http://h:1/v1?a=2")).toBe(false);
  });
});
