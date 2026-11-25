// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  formatBundleShowPlain,
  formatClonePlain,
  formatIndexPlain,
  formatInitPlain,
  formatListPlain,
  formatModelsPlain,
  formatModelsSetPlain,
  formatRemovePlain,
} from "../src/output/text/lifecycle-format";

describe("lifecycle formatters", () => {
  test("init", () => {
    expect(formatInitPlain({})).toBe("Bundle initialized at unknown");
    expect(formatInitPlain({ bundleDir: "/b", configPath: "/c" })).toBe("Bundle initialized at /b\nConfig saved to /c");
    expect(formatInitPlain({ bundleDir: "/b", defaultBundleUpdated: false, previousBundleDir: "/p" })).toBe(
      "Bundle initialized at /b\nYour default bundle is unchanged (/p). Re-run with --set-default to make /b the default.",
    );
  });

  test("index", () => {
    expect(formatIndexPlain({ exported: { file: "f.json", vectors: 3 } })).toBe("Exported 3 vectors to f.json");
    expect(formatIndexPlain({})).toBe("Indexed 0 entries from 0 directories (mode: unknown)");
    const timing = {
      totalMs: 1,
      preflightMs: 2,
      walkMs: 3,
      llmMs: 4,
      embedMs: 5,
      ftsMs: 6,
      finalizeMs: 7,
      cleanMs: 8,
      endToEndMs: 9,
    };
    expect(
      formatIndexPlain({
        totalEntries: 5,
        directoriesScanned: 2,
        mode: "full",
        warnings: ["w1", "w2"],
        verification: { ok: false, message: "bad" },
        timing,
      }),
    ).toBe(
      "Indexed 5 entries from 2 directories (mode: full)\nWarnings (2):\n  - w1\n  - w2\nVerification: bad\n" +
        "Timing: total 1ms, preflight 2ms, walk 3ms, llm 4ms, embeddings 5ms, fts 6ms, finalize 7ms, clean 8ms, end-to-end 9ms",
    );
  });

  test("list", () => {
    expect(formatListPlain({})).toBe("No sources configured. Use `akm bundle add` to add a source.");
    expect(
      formatListPlain({
        sources: [{ kind: "git", name: "n", version: "1", provider: "p", default: true, writable: true }, {}],
      }),
    ).toBe(
      "[git] n v1 (p) [default, writable]\n[unknown] unnamed\n\nTo search: akm search '<query>'  |  To view an asset: akm show <ref>",
    );
  });

  test("models", () => {
    expect(formatModelsPlain({})).toBe(
      "Connection ? has no model aliases. Set one with `akm models set <alias> <model>`.",
    );
    expect(formatModelsPlain({ connection: "c", aliases: { fast: "m1", a: "m2" }, available: ["x", "y"] })).toBe(
      "Connection c\nALIAS  MODEL\nfast   m1\na      m2\n\nAVAILABLE\n  x\n  y",
    );
    expect(formatModelsPlain({ connection: "c", available: ["x"] })).toBe("Connection c\nAVAILABLE\n  x");
    expect(formatModelsSetPlain({ alias: "a", model: "m", connection: "c", previous: "old" })).toBe(
      "a -> m on connection c (was old)",
    );
    expect(formatModelsSetPlain({ alias: "a", model: "m", connection: "c" })).toBe("a -> m on connection c");
  });

  test("bundle show", () => {
    expect(formatBundleShowPlain({})).toBe("unknown [unknown]\n  items: 0");
    expect(
      formatBundleShowPlain({
        name: "n",
        kind: "git",
        default: true,
        writable: true,
        version: "1",
        provider: "p",
        path: "/x",
        ref: "r",
        registryId: "id",
        itemCount: 4,
        byType: { skill: 2, lesson: 2 },
        status: { exists: false },
      }),
    ).toBe(
      "n [git]\n  default: true\n  writable: true\n  version: 1\n  provider: p\n  path: /x\n  ref: r\n  registryId: id\n  items: 4\n  byType: skill=2, lesson=2\n  status: MISSING on disk",
    );
  });

  test("remove and clone", () => {
    expect(formatRemovePlain({ target: "t" })).toBe("remove: t OK");
    expect(formatRemovePlain({ ref: "r", ok: false })).toBe("remove: r FAILED");
    expect(formatClonePlain({})).toBe("Cloned → unknown");
    expect(formatClonePlain({ destination: { path: "/d" }, remoteFetched: true, overwritten: true })).toBe(
      "Cloned (fetched from remote) → /d (overwritten)",
    );
  });
});
