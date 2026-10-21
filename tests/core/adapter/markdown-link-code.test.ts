// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { resolveBodyLinks } from "../../../src/core/adapter/adapters/llm-wiki-adapter";
import { okfAdapter, resolveOkfLinks } from "../../../src/core/adapter/adapters/okf-adapter";
import type { ValidateContext } from "../../../src/core/adapter/types";

const codeExamples = [
  "`[example](./missing.md)`",
  "``[example](./missing.md) ` literal``",
  "```[example](./missing.md) `` literal```",
  "```md\n[example](./missing.md)\n```",
  "~~~markdown\n[example](./missing.md)\n~~~",
  "   ~~~~md\r\n[example](./missing.md)\r\n~~~\r\n[example](./still-code.md)\r\n~~~~\r\n",
  "````md\n```\n[example](./missing.md)\n````",
  "~~~md\n```\n[example](./missing.md)\n~~~",
  "~~~md\n[example](./missing.md)",
  "`[example]\n(./missing.md)`",
];

for (const [name, resolve] of [
  ["okf", resolveOkfLinks],
  ["llm-wiki", resolveBodyLinks],
] as const) {
  describe(`${name} document links outside code`, () => {
    test.each(codeExamples)("ignores code: %s", (body) => {
      expect(resolve(body, "pages/start.md")).toEqual([]);
      expect(resolve(`[before](./before.md)\n\n${body}\n\n[after](/after.md)`, "pages/start.md")).toEqual(
        body === codeExamples[8] ? ["pages/before"] : ["pages/before", "after"],
      );
    });

    test("fences follow list and blockquote containers, including missing closers", () => {
      for (const body of [
        "- ```md\n  [fake](/fake.md)\n  ```\n\n[real](/real.md)",
        "1. ~~~md\n   [fake](/fake.md)\n   ~~~\n\n[real](/real.md)",
        "- - ~~~md\n    [fake](/fake.md)\n    ~~~\n\n[real](/real.md)",
        "> > ~~~md\n> > [fake](/fake.md)\n> > ~~~\n[real](/real.md)",
        "> ~~~md\n> [fake](/fake.md)\n\n[real](/real.md)",
        "- ~~~md\n  [fake](/fake.md)\n\n[real](/real.md)",
        "- item\n    ~~~md\n    [fake](/fake.md)\n    ~~~\n\n[real](/real.md)",
        "> - ~~~md\n>   [fake](/fake.md)\n>   ~~~\n\n[real](/real.md)",
        "- > ```\n  > [fake](/fake.md)\n  > ```\n\n[real](/real.md)",
      ]) {
        expect(resolve(body, "pages/start.md")).toEqual(["real"]);
      }
    });

    test("retains supported paths, titles, fragments, queries, deduplication and order", () => {
      const body = [
        '[real](./real.md "Title") `[noise](./noise.md)` [same](./real.md#heading)',
        "[root](/root.md?mode=read#heading) [parent](../parent.md#heading?mode=read)",
        "[external](https://example.com/x.md) [mail](mailto:x.md) [protocol](//example.com/x.md)",
        "[anchor](#heading) [other](./image.png) [escape](../../outside.md) [root-escape](/../outside.md)",
        "[[wiki title]] [broken](./missing.md) [empty]() [unclosed](./unclosed.md",
      ].join("\n");
      expect(resolve(body, "pages/start.md")).toEqual(["pages/real", "root", "parent", "pages/missing"]);
    });

    test("unmatched or escaped backticks do not swallow real links", () => {
      expect(resolve("` unmatched [real](./real.md)", "pages/start.md")).toEqual(["pages/real"]);
      expect(resolve("\\` [real](./real.md) \\`", "pages/start.md")).toEqual(["pages/real"]);
      expect(resolve("` unmatched\n\n[real](./real.md) `", "pages/start.md")).toEqual(["pages/real"]);
    });
  });
}

test("OKF reference links use real definitions and uses, preserving authored order", () => {
  const body = [
    "[root][ROOT] [inline](./second.md) [again][root] `[hidden][third]`",
    "",
    '[root]: /first.md "Root title"',
    "[third]: /third.md",
    "`[inline-code]: /inline-code.md`",
    "[inline-code-use][inline-code]",
    "~~~md",
    "[example]: /example.md",
    "~~~",
    "[example-use][example]",
  ].join("\n");
  expect(resolveOkfLinks(body, "pages/start.md")).toEqual(["first", "pages/second"]);
  // Reference-style links and [[wiki links]] are not indexed wiki syntax.
  expect(resolveBodyLinks("[root][root]\n[root]: /first.md\n[[first]]", "pages/start.md")).toEqual([]);
});

test("tokenization does not expand indexed reference or angle-destination syntax", () => {
  const body = [
    '[angle](</angle.md>) [titled](</titled.md> "title") [ordinary](/ordinary.md)',
    "[shortcut] [collapsed][] [explicit][plain] [angle-reference][angle]",
    "",
    "[shortcut]: /shortcut.md",
    "[collapsed]: /collapsed.md",
    "[plain]: /plain.md",
    "[angle]: </angle-ref.md>",
  ].join("\n");
  expect(resolveOkfLinks(body, "start.md")).toEqual(["ordinary", "plain"]);
  expect(resolveBodyLinks(body, "start.md")).toEqual(["ordinary"]);
});

test("code examples inside real link labels do not create extra targets", () => {
  const body = "[label `[fake](./fake.md)`](./real.md) [other](./other.md)";
  expect(resolveOkfLinks(body, "pages/start.md")).toEqual(["pages/real", "pages/other"]);
  expect(resolveBodyLinks(body, "pages/start.md")).toEqual(["pages/real", "pages/other"]);
});

test("OKF code examples produce no broken-link diagnostic; a real missing link remains tolerant", async () => {
  const visited: string[] = [];
  const ctx: ValidateContext = {
    readFile: async () => null,
    list: async () => [],
    resolveRef: async (ref) => {
      visited.push(ref);
      return { exists: false };
    },
  };
  const diagnostics = await okfAdapter.validate(
    { id: "sample", root: "/sample", adapter: "okf", writable: false },
    [
      {
        path: "pages/start.md",
        op: "create",
        after: `---\ntype: note\nupdated: 2026-10-20\n---\n\n${codeExamples.filter((_, index) => index !== 8).join("\n\n")}\n\n[real](./real.md)`,
      },
    ],
    ctx,
  );
  expect(visited).toEqual(["pages/real"]);
  expect(diagnostics.filter((entry) => entry.issue === "missing-ref")).toEqual([
    expect.objectContaining({ detail: expect.stringContaining("pages/real (non-blocking") }),
  ]);
});
