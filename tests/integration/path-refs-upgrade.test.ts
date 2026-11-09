// Classification (tests/integration/ iff it opens a real database): opens index.db and state.db.

/**
 * A file outside its type folder had the ref `<type folder>/<its path>` before refs became bundle-relative paths.
 * The runtime still resolves the old spelling (show, links authored with it); re-keying the history stored under it
 * is the migrator's job (tests/migrate/asset-content-refs.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../src/commands/read/show";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { withSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  _resetWarnOnceForTests();
});

afterEach(() => storage.cleanup());

function write(rel: string, body: string): string {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${body}\n---\n\n# ${body}\n`);
  return file;
}

describe("show resolves a loose file by its path", () => {
  test("the path ref shows it; the old spelling shows it too, and warns once that it is outdated", async () => {
    write("reports/x.md", "quarterly report");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const shown = await akmShowUnified({ ref: "reports/x", readOnly: true });
    expect(shown.ref).toBe("reports/x");
    expect(shown.type).toBe("knowledge");

    const warnings: string[] = [];
    await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      },
      async () => {
        const old = await akmShowUnified({ ref: "knowledge/reports/x", readOnly: true });
        expect(old.path).toBe(shown.path);
        await akmShowUnified({ ref: "knowledge/reports/x", readOnly: true });
      },
    );
    expect(warnings.filter((w) => /outdated/.test(w))).toHaveLength(1);
  });
});

describe("links authored with the old spelling", () => {
  test("resolve to the loose file in both directions", async () => {
    write("reports/x.md", "quarterly report");
    const citer = path.join(storage.stashDir, "memories", "citer.md");
    fs.mkdirSync(path.dirname(citer), { recursive: true });
    fs.writeFileSync(citer, "---\ndescription: cites a report\nxrefs:\n  - knowledge/reports/x\n---\n\n# Cites\n");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const outgoing = await akmShowUnified({ ref: "memories/citer", readOnly: true });
    expect(outgoing.links).toEqual({ outgoing: { xref: { total: 1, refs: ["reports/x"] } } });
    const incoming = await akmShowUnified({ ref: "reports/x", readOnly: true });
    expect(incoming.links).toEqual({ incoming: { xref: { total: 1, refs: ["memories/citer"] } } });
  });
});
