// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { runAutoHeuristics } from "../src/commands/remember";
import { checkDeadUrls } from "../src/commands/url-checker";
import { urlsInText } from "../src/core/urls";

describe("urlsInText: URLs without the sentence's punctuation (B10-32)", () => {
  test("trailing sentence punctuation is not part of the URL", () => {
    expect(urlsInText("Docs at https://example.com/mcp.")).toEqual(["https://example.com/mcp"]);
    expect(urlsInText("See https://a.io/x, https://b.io/y; and https://c.io/z!")).toEqual([
      "https://a.io/x",
      "https://b.io/y",
      "https://c.io/z",
    ]);
  });

  test("a closing parenthesis with no opening one is the prose's; a balanced one is the URL's", () => {
    expect(urlsInText("(https://y.io/a)")).toEqual(["https://y.io/a"]);
    expect(urlsInText("see https://x.io/a_(b) now")).toEqual(["https://x.io/a_(b)"]);
  });

  test("the dead-URL check requests the URL without trailing punctuation", async () => {
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requested.push(String(input));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    try {
      const result = await checkDeadUrls("/unused", [{ ref: "knowledge/a", body: "Docs at https://example.com/mcp." }]);
      expect(requested).toEqual(["https://example.com/mcp"]);
      expect(result.deadUrls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("remember's derived source is the first URL without trailing punctuation", () => {
    expect(runAutoHeuristics("Read https://example.com/mcp. Then act.").source).toBe("https://example.com/mcp");
  });
});
