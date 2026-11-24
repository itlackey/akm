// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `scripts/lint-asset-io.ts` counts the code that reads or writes assets outside the adapter layer and holds it to a
 * checked-in baseline that can only shrink. It must pass on the real tree, find each kind of violation in a
 * fixture, fail on a violation the baseline lacks, and fail on a baseline entry that no longer occurs.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { compare, countsOf, REASONS, scan } from "../../../scripts/lint-asset-io";
import { makeSandboxDir } from "../../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const IDS = ["akm", "okf", "akm-workflow"];

function violationsIn(files: Record<string, string>) {
  const sandbox = makeSandboxDir("akm-asset-io");
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const destination = path.join(sandbox.dir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, "utf8");
    }
    return scan(sandbox.dir, IDS).map(([file, rule]) => `${file} ${rule}`);
  } finally {
    sandbox.cleanup();
  }
}

/** Only the violations of `rules`: facade fixtures also trip `facade-export` when nothing imports them. */
function violationsOf(rules: string[], files: Record<string, string>) {
  return violationsIn(files).filter((v) => rules.includes(v.split(" ")[1] ?? ""));
}

describe("lint-asset-io", () => {
  test("passes on the real source tree: it matches its baseline exactly", () => {
    const result = Bun.spawnSync([process.execPath, path.join(REPO_ROOT, "scripts", "lint-asset-io.ts")], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("finds each rule's violation outside the adapter layer", () => {
    expect(
      violationsIn({
        "src/feature/read.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync("x", "utf8");\n',
        "src/feature/stat.ts":
          'import fs from "node:fs";\nexport const a = [fs.existsSync(p), fs.statSync(p), fs.lstatSync(p), fs.openSync(p, "r"), readTextFile(p)];\n',
        "src/feature/walk.ts": "export const b = walkStashFlat(root);\n",
        "src/feature/adapter.ts":
          'import { akmAdapter } from "../core/adapter/adapters/akm-adapter";\nexport { akmAdapter };\n',
        "src/feature/internal.ts":
          'import { AssetBundle } from "../core/assets/bundle";\nexport type T = AssetBundle;\n',
        "src/feature/compare.ts": 'export const c = source.adapterId === "okf";\n',
        "src/feature/subject.ts": 'export const d = provider === "akm";\n',
        "src/feature/switch.ts": 'switch (adapterId) {\n  case "akm":\n    break;\n}\n',
        "src/feature/location.ts": 'export const e = entry.kind === "location";\n',
        "src/feature/fileless.ts": "export const f = doc.fileless;\n",
        "src/feature/entry-file.ts": "export const g = [entry.file, hit.entry.file];\n",
      }).sort(),
    ).toEqual([
      "src/feature/adapter.ts adapter-import",
      "src/feature/compare.ts adapter-id",
      "src/feature/entry-file.ts entry-file",
      "src/feature/entry-file.ts entry-file",
      "src/feature/fileless.ts adapter-id",
      "src/feature/internal.ts facade-internal",
      "src/feature/location.ts adapter-id",
      "src/feature/read.ts asset-io",
      "src/feature/stat.ts asset-io",
      "src/feature/stat.ts asset-io",
      "src/feature/stat.ts asset-io",
      "src/feature/stat.ts asset-io",
      "src/feature/stat.ts asset-io",
      "src/feature/subject.ts adapter-id",
      "src/feature/switch.ts adapter-id",
      "src/feature/walk.ts asset-io",
    ]);
  });

  test("lets through the adapter layer, allowed paths, the contract imports and unrelated comparisons", () => {
    expect(
      violationsIn({
        "src/core/adapter/adapters/x.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync("x");\n',
        "src/core/assets/read.ts":
          'import { akmAdapter } from "../adapter/adapters/akm-adapter";\nimport { AssetBundle } from "./bundle";\nexport const a = [akmAdapter, AssetBundle, entry.file];\n',
        "src/storage/db.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync("x");\n',
        "src/feature/contract.ts":
          'import type { BundleAdapter } from "../core/adapter/bundle-adapter";\nimport type { Bundle } from "../core/adapter/types";\nexport type T = [BundleAdapter, Bundle];\n',
        "src/feature/other.ts": 'export const p = [runner.platform === "claude", kind === "file", entry.fileName];\n',
        "src/feature/uses.ts": 'import { a } from "../core/assets/read";\nexport const b = a;\n',
      }),
    ).toEqual([]);
  });

  test("an exemption with a reason from the vocabulary passes and is counted; entry-file takes display and exec only", () => {
    const exemptions: string[] = [];
    const sandbox = makeSandboxDir("akm-asset-io");
    try {
      const file = path.join(sandbox.dir, "src/feature/exempt.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          'import fs from "node:fs";',
          "export const a = fs.readFileSync(p); // asset-io: config",
          "// asset-io: state run record",
          "export const b = fs.existsSync(q);",
          "export const c = fs.statSync(r); // asset-io: user-input a named file",
          "export const d = entry.file; // asset-io: display",
          "// asset-io: exec",
          "export const e = hit.entry.file;",
          "export const f = entry.file; // asset-io: state",
          "",
        ].join("\n"),
        "utf8",
      );
      const violations = scan(sandbox.dir, IDS, exemptions).map(([, rule, line]) => `${rule}:${line}`);
      // Only line 9 fails: `state` is no reason for an entry.file.
      expect(violations).toEqual(["entry-file:9"]);
      expect(exemptions.sort()).toEqual(["config", "display", "exec", "state", "user-input"]);
    } finally {
      sandbox.cleanup();
    }
  });

  test("an exemption without a reason, or with one outside the vocabulary, is no exemption", () => {
    expect(
      violationsIn({
        "src/feature/bare.ts": 'import fs from "node:fs";\nexport const a = fs.readFileSync(p); // asset-io:\n',
        "src/feature/unknown.ts":
          'import fs from "node:fs";\nexport const a = fs.readFileSync(p); // asset-io: because\nexport const b = fs.statSync(p); // asset-io: user-supplied input\n',
        "src/feature/wrong-rule.ts": "export const a = entry.file; // asset-io: config\n",
      }).sort(),
    ).toEqual([
      "src/feature/bare.ts asset-io",
      "src/feature/unknown.ts asset-io",
      "src/feature/unknown.ts asset-io",
      "src/feature/wrong-rule.ts entry-file",
    ]);
  });

  test("the allowances of the readers the migration removes are gone", () => {
    expect(
      violationsIn(
        Object.fromEntries(
          [
            "src/indexer/walk/walker.ts",
            "src/indexer/passes/metadata.ts",
            "src/workflows/source-files.ts",
            "src/indexer/indexer.ts",
            "src/indexer/scan/scan.ts",
            "src/commands/lint/index.ts",
            "src/commands/sources/source-add.ts",
          ].map((file) => [file, 'import fs from "node:fs";\nexport const a = fs.readFileSync("x");\n']),
        ),
      ),
    ).toHaveLength(7);
  });

  test("flags async file access by where it comes from, in src and in the Desktop server", () => {
    expect(
      violationsIn({
        "src/feature/promises.ts":
          'import fs from "node:fs";\nexport const a = [fs.promises.stat(p), fs.promises.readdir(p), fs.promises.rm(p)];\nexport const b = Bun.write(p, "x");\n',
        "src/feature/named.ts":
          'import { rename, writeFile as put } from "node:fs/promises";\nexport const a = [rename(a, b), put(p, "x")];\n',
        "src/feature/alias.ts": 'import { readFileSync as read } from "node:fs";\nexport const a = read(p);\n',
        "src/feature/ns.ts": 'import { promises as fsp } from "node:fs";\nexport const a = fsp.readFile(p);\n',
        "src/feature/unrelated.ts":
          "export const a = [db.rename(a, b), service.stat(p), cache.rm(k), readFile(p, root), writeFile(p)];\n",
        "desktop/src/lib/server/features/other.ts": 'import fs from "node:fs";\nexport const a = fs.statSync(p);\n',
        "desktop/src/lib/server/features/files.ts": 'import fs from "node:fs";\nexport const a = fs.statSync(p);\n',
      }).sort(),
    ).toEqual([
      "desktop/src/lib/server/features/other.ts asset-io",
      "src/feature/alias.ts asset-io",
      "src/feature/named.ts asset-io",
      "src/feature/named.ts asset-io",
      "src/feature/ns.ts asset-io",
      "src/feature/promises.ts asset-io",
      "src/feature/promises.ts asset-io",
      "src/feature/promises.ts asset-io",
      "src/feature/promises.ts asset-io",
    ]);
  });

  test("adapter-id skips the listed non-adapter names and nothing else", () => {
    expect(
      violationsIn({
        "src/feature/names.ts":
          'export const a = [harness === "akm", p.platform === "okf", path.basename(f) === "akm", cfg.binary !== "akm", bin === "okf", command.toLowerCase() === "akm"];\n',
        "src/feature/flagged.ts":
          'export const a = [id === "akm", x.adapter === "okf", constructor === "akm", fn() === "akm"];\n',
      }).sort(),
    ).toEqual([
      "src/feature/flagged.ts adapter-id",
      "src/feature/flagged.ts adapter-id",
      "src/feature/flagged.ts adapter-id",
      "src/feature/flagged.ts adapter-id",
    ]);
  });

  test("adapter-probe flags a call of detectAdapterId or adapterIdOf, even in an allowed path", () => {
    expect(
      violationsIn({
        "src/feature/probe.ts": "export const a = [detectAdapterId(dir), installations.adapterIdOf(entry)];\n",
        "src/storage/probe.ts": "export const a = detectAdapterId(dir);\n",
        "src/core/adapter/detect.ts": "export const a = detectAdapterId(dir);\n",
      }).sort(),
    ).toEqual([
      "src/feature/probe.ts adapter-probe",
      "src/feature/probe.ts adapter-probe",
      "src/storage/probe.ts adapter-probe",
    ]);
  });

  test("the adapter layer (the walk included) and the metadata helpers may import adapter modules; other readers may not", () => {
    const code = 'import { x } from "../../core/adapter/registry";\nexport const a = x;\n';
    expect(
      violationsIn({
        "src/core/adapter/directory/file-context.ts": code,
        "src/indexer/passes/metadata.ts": code,
        "src/indexer/passes/other.ts": code,
      }),
    ).toEqual(["src/indexer/passes/other.ts adapter-import"]);
  });

  test("adapter-import counts an outside import of the walk (directory/), and an adapter-layer import of it is free", () => {
    expect(
      violationsOf(["adapter-import"], {
        "src/workspace/place.ts":
          'import { placeRules } from "../core/adapter/directory/place-rules";\nexport const a = placeRules;\n',
        "src/indexer/walk-user.ts":
          'import { walk } from "../core/adapter/directory/walker.js";\nexport const a = walk;\n',
        "src/core/adapter/adapters/x.ts": 'import { walk } from "../directory/walker";\nexport const a = walk;\n',
        "src/core/assets/files.ts": 'import { walk } from "../adapter/directory/walker";\nexport const a = walk;\n',
        "src/feature/contract.ts": 'import type { Bundle } from "../core/adapter/types";\nexport type T = Bundle;\n',
      }).sort(),
    ).toEqual(["src/indexer/walk-user.ts adapter-import", "src/workspace/place.ts adapter-import"]);
  });

  test("facade-fs flags file access inside src/core/assets/ and not registry calls or other code", () => {
    expect(
      violationsOf(["facade-fs"], {
        "src/core/assets/a.ts":
          'import fs from "node:fs";\nimport { stat } from "node:fs/promises";\nexport const a = [fs.existsSync(p), stat(p), Bun.file(p), readTextFile(p), adapterForId(id), getAdapters(), db.stat(p)];\n',
        "src/core/assets/b.ts": "export const a = [readFile, `existsSync(p)`]; // fs.readFileSync(p)\n",
        "src/core/adapter/adapters/x.ts": 'import fs from "node:fs";\nexport const a = fs.existsSync(p);\n',
      }).sort(),
    ).toEqual([
      "src/core/assets/a.ts facade-fs",
      "src/core/assets/a.ts facade-fs",
      "src/core/assets/a.ts facade-fs",
      "src/core/assets/a.ts facade-fs",
    ]);
    // Only `deprecated` exempts it; `config` does not.
    expect(
      violationsOf(["facade-fs"], {
        "src/core/assets/c.ts":
          'import fs from "node:fs";\nexport const a = fs.existsSync(p); // asset-io: config\nexport const b = fs.statSync(p); // asset-io: deprecated\n',
      }),
    ).toEqual(["src/core/assets/c.ts facade-fs"]);
  });

  test("facade-adapter-id flags adapter-id comparisons inside the facade, and not names, strings or comments", () => {
    expect(
      violationsOf(["facade-adapter-id"], {
        "src/core/assets/a.ts":
          'export const a = [x === "akm", y.adapterId !== "akm-workflow", z.kind === "location", w.fileless];\nswitch (id) {\n  case "okf":\n    break;\n}\n',
        "src/core/assets/b.ts":
          'export const a = [harness === "akm", ids.includes("akm"), "akm", `akm`, kind === "file", name === "akm-x"]; // a === "akm"\n',
        "src/core/adapter/adapters/x.ts": 'export const a = id === "akm";\n',
      }).sort(),
    ).toEqual([
      "src/core/assets/a.ts facade-adapter-id",
      "src/core/assets/a.ts facade-adapter-id",
      "src/core/assets/a.ts facade-adapter-id",
      "src/core/assets/a.ts facade-adapter-id",
      "src/core/assets/a.ts facade-adapter-id",
    ]);
  });

  test("store-sniff flags isStore, addressedBy and a compared .location outside the adapter layer", () => {
    expect(
      violationsOf(["store-sniff"], {
        "src/feature/sniff.ts":
          'export const a = [scan.isStore ? 1 : 2, bundle.addressedBy("x"), addressedBy(b), source.location === undefined, entry.location !== undefined, "x" === cfg.location];\n',
        "src/feature/clean.ts":
          'export const a = { isStore: true, location: loc, ...{ location } }; // x.isStore, a.location === b\nexport const b = ["isStore", "a.location === b", window.location.href, entry.location ?? "", entry.locationKey === 1, isStoreLike(x)];\nconst isStore = 1;\nexport const c = { isStore };\n',
        "src/core/adapter/x.ts": "export const a = [s.isStore, s.location === undefined];\n",
        "src/core/assets/x.ts": "export const a = [s.isStore, s.location === undefined];\n",
      }).sort(),
    ).toEqual([
      "src/feature/sniff.ts store-sniff",
      "src/feature/sniff.ts store-sniff",
      "src/feature/sniff.ts store-sniff",
      "src/feature/sniff.ts store-sniff",
      "src/feature/sniff.ts store-sniff",
      "src/feature/sniff.ts store-sniff",
    ]);
  });

  test("entries-sql flags raw SQL on entries or index_meta outside storage, the facade and the indexer", () => {
    expect(
      violationsOf(["entries-sql"], {
        "src/commands/sql.ts":
          'export const a = [db.prepare("SELECT id FROM entries WHERE id = ?"), db.run(`DELETE FROM index_meta WHERE key = ${k}`), "insert into entries (a) values (1)", "UPDATE entries SET a = 1"];\n',
        "src/core/adapter/directory/q.ts": 'export const a = "SELECT 1 FROM entries";\n',
        "src/storage/q.ts": 'export const a = "SELECT 1 FROM entries";\n',
        "src/core/assets/q.ts": 'export const a = "SELECT 1 FROM index_meta";\n',
        "src/indexer/q.ts": 'export const a = "SELECT 1 FROM entries";\n',
        "src/commands/prose.ts":
          '// SELECT id FROM entries\nexport const a = ["the entries table", "Object.entries(x)", "SELECT 1 FROM entries_fts", "from entries of the log", "select from the index_meta"];\nexport const b = Object.entries(x);\n',
      }).sort(),
    ).toEqual([
      "src/commands/prose.ts entries-sql",
      "src/commands/sql.ts entries-sql",
      "src/commands/sql.ts entries-sql",
      "src/commands/sql.ts entries-sql",
      "src/commands/sql.ts entries-sql",
      "src/core/adapter/directory/q.ts entries-sql",
    ]);
  });

  test("entry-file-logic flags entry.file compared or used as a key, even under a display exemption", () => {
    expect(
      violationsIn({
        "src/feature/logic.ts": [
          "export const a = [entry.file === p, p !== hit.entry.file, entry.file < p, (entry.file as string) == q];",
          "export const b = [seen.has(entry.file), byFile.get(hit.entry.file), seen.add(entry.file), byFile.set(entry.file, 1), byFile.delete(entry.file)];",
          "export const c = [byFile[entry.file], { [entry.file]: 1 }];",
          "export const d = entry.file === p; // asset-io: display",
          "",
        ].join("\n"),
        "src/feature/print.ts": [
          "export const a = [entry.file, `${entry.file}`, path.relative(root, entry.file), entry.file ?? '', entry.file.length > 2, entry.files === p];",
          "export const b = { file: entry.file }; // entry.file === p",
          "export const c = [other.file === p, byFile.get(entry.fileName), byFile.get(p, entry.file)];",
          "",
        ].join("\n"),
        "src/core/assets/x.ts": "export const a = [entry.file === p, seen.has(entry.file)];\n",
      })
        .filter((v) => v.endsWith("entry-file-logic"))
        .map((v) => v.split(" ")[0]),
    ).toEqual(Array(12).fill("src/feature/logic.ts"));
  });

  test("facade-export flags a public facade export nothing outside the facade imports", () => {
    expect(
      violationsIn({
        "src/core/assets/read.ts":
          "export function used() {}\nexport function viaNamespace() {}\nexport type Aliased = string;\nexport const unused = 1;\nexport { helper as renamed };\nconst helper = 1;\nexport function onlyInside() {}\n",
        "src/core/assets/write.ts": 'import { onlyInside } from "./read";\nexport const w = onlyInside;\n',
        "src/core/assets/bundle.ts": "export const internal = 1;\n",
        "src/feature/caller.ts":
          'import { used, type Aliased as Mine } from "../core/assets/read";\nimport * as read from "../core/assets/read";\nexport const a = [used, read.viaNamespace, {} as Mine];\n',
      }).sort(),
    ).toEqual([
      "src/core/assets/read.ts facade-export",
      "src/core/assets/read.ts facade-export",
      "src/core/assets/read.ts facade-export",
      "src/core/assets/write.ts facade-export",
    ]);
  });

  test("an exemption's first word must be in the vocabulary, and a rule accepts only its reasons", () => {
    const reasons = Object.keys(REASONS);
    expect(reasons).toContain("deprecated");
    const nearMisses = ["Config", "config_x", "state-run", "states", "user_input", "files view", "deprecated_old", ""];
    expect(
      violationsIn(
        Object.fromEntries(
          nearMisses.map((reason, i) => [
            `src/feature/near${i}.ts`,
            `import fs from "node:fs";\nexport const a = fs.readFileSync(p); // asset-io: ${reason}\n`,
          ]),
        ),
      ),
    ).toHaveLength(nearMisses.length);
    // Every vocabulary word exempts file access, and `deprecated` the other rules; the storage reasons do not.
    expect(
      violationsIn({
        "src/feature/all.ts": `import fs from "node:fs";\n${reasons
          .map((reason) => `export const ${reason.replace("-", "_")} = fs.readFileSync(p); // asset-io: ${reason}`)
          .join("\n")}\n`,
        "src/feature/deprecated.ts":
          'import { x } from "../core/adapter/registry"; // asset-io: deprecated\nexport const a = [x === "akm", detectAdapterId(d), entry.file]; // asset-io: deprecated\n',
        "src/feature/storage-reason.ts":
          'import { x } from "../core/adapter/registry"; // asset-io: state\nexport const a = [x === "akm", detectAdapterId(d)]; // asset-io: config\n',
      }).sort(),
    ).toEqual([
      "src/feature/storage-reason.ts adapter-id",
      "src/feature/storage-reason.ts adapter-import",
      "src/feature/storage-reason.ts adapter-probe",
    ]);
  });

  test("a baseline that matches passes; a new violation, a traded callee and a stale entry each fail", () => {
    const found = countsOf([
      ["src/a.ts", "asset-io", 3, "readFileSync"],
      ["src/a.ts", "asset-io", 9, "readFileSync"],
      ["src/b.ts", "adapter-import", 1, "src/core/adapter/registry"],
      ["src/b.ts", "entry-file", 4, "entry.file"],
    ]);
    expect(found).toEqual({
      "src/a.ts": { "asset-io": { readFileSync: 2 } },
      "src/b.ts": { "adapter-import": { "src/core/adapter/registry": 1 }, "entry-file": { "entry.file": 1 } },
    });

    expect(compare(found, found)).toEqual({ added: [], stale: [] });

    // A violation the baseline lacks: a new rule in a known file, one more in a known file.
    expect(
      compare(found, { ...found, "src/b.ts": { "adapter-import": found["src/b.ts"]?.["adapter-import"] } }).added,
    ).toEqual(["src/b.ts: entry-file entry.file 0 -> 1"]);
    expect(compare(found, { ...found, "src/a.ts": { "asset-io": { readFileSync: 1 } } }).added).toEqual([
      "src/a.ts: asset-io readFileSync 1 -> 2",
    ]);

    // Trading one violation for another keeps the file's count and still fails, both ways.
    const traded = compare(found, { ...found, "src/a.ts": { "asset-io": { readFileSync: 1, existsSync: 1 } } });
    expect(traded.added).toEqual(["src/a.ts: asset-io readFileSync 1 -> 2"]);
    expect(traded.stale).toEqual(["src/a.ts: asset-io existsSync 1 -> 0"]);

    // A baseline entry that no longer occurs: a gone file, or a count that shrank.
    expect(compare(found, { ...found, "src/gone.ts": { "adapter-id": { akm: 1 } } }).stale).toEqual([
      "src/gone.ts: adapter-id akm 1 -> 0",
    ]);
    expect(compare(found, { ...found, "src/a.ts": { "asset-io": { readFileSync: 5 } } }).stale).toEqual([
      "src/a.ts: asset-io readFileSync 5 -> 2",
    ]);
  });
});
