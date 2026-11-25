// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression + closed-form coverage for #857.
 *
 * Finding an asset in a bundle used to walk the ENTIRE bundle root on every
 * single-ref lookup (`scanRegularAuthoredPaths`/`scannedReadCandidates`,
 * capped at 16,384 files / 4,096 directories), throwing
 * `AdapterConceptScanError` past the cap — a hard operational wall on any
 * bundle bigger than the cap (issue #857). That walk is gone: each adapter's
 * `spellings` enumerates the CLOSED-FORM set of physical spellings a
 * conceptId could own directly (canonical, loose off-canonical, and any
 * type-specific duality), so lookups cost a small, bundle-size-INDEPENDENT
 * number of `readdirSync` calls (one parent listing per spelling), never a walk.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { buildFileContext, type FileContext } from "../../../src/core/adapter/directory/file-context";
import type { Asset } from "../../../src/core/assets/asset";
import * as facade from "../../../src/core/assets/read";
import { assetRevision } from "../../../src/core/assets/read";
import { assetType, assetTypeFresh } from "../../../src/core/assets/type";
import * as facadeWrite from "../../../src/core/assets/write";
import { writeAssets } from "../../../src/core/assets/write";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { NotFoundError, UsageError } from "../../../src/core/errors";
import { getDbPath } from "../../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { beginWriteProvenance } from "../../../src/core/write-provenance";
import { type ResolvedWriteTarget, resolveWriteTarget } from "../../../src/core/write-source";
import { akmIndex } from "../../../src/indexer/indexer";
import { resolveSourceEntries, type SearchSource } from "../../../src/indexer/search/search-source";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { configureBundles } from "../../_helpers/bundle-config";
import { withFakeSecretStores } from "../../_helpers/fake-secret-stores";
import { findInBundle } from "../../_helpers/find-in-bundle";
import {
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

// The facade takes bundle ids and bundles are the config's: these wrappers make a test's sources the config's bundles
// first, so each test still names the bundles it reads.
type TestSource = SearchSource & { path: string };
type Sources = { sources: readonly TestSource[] };
const asBundle = (source: TestSource) => ({
  path: source.path,
  ...(source.registryId !== undefined ? { registryId: source.registryId } : {}),
  ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
  ...(source.location !== undefined ? { location: source.location } : {}),
});
const findAsset = (ref: string, options?: Sources) => {
  if (options) configureBundles(options.sources.map(asBundle));
  return facade.findAsset(options ? facade.qualifyRef(ref) : ref);
};
const requireAsset = (ref: string, { sources }: Sources) => {
  configureBundles(sources.map(asBundle));
  return facade.requireAsset(facade.qualifyRef(ref));
};
const listAssets = ({ sources, ...options }: Sources & { bundle?: string; type?: string }) => {
  configureBundles(sources.map(asBundle));
  return facade.listAssets(options);
};
const currentConceptId = (ref: { conceptId: string }, sources: readonly TestSource[]) => {
  configureBundles(sources.map(asBundle));
  return facade.currentConceptId(ref.conceptId);
};
const addressOf = (source: { name: string; path: string; adapterId?: string }, ref: string) => {
  const [id] = configureBundles([
    { path: source.path, registryId: source.name, ...(source.adapterId ? { adapterId: source.adapterId } : {}) },
  ]);
  return facadeWrite.addressOf(id as string, ref);
};

describe("finding an asset in one bundle — closed-form candidates (#857)", () => {
  test("spellings for a nested-off-canonical conceptId resolve without any readdirSync count growing with unrelated tree size", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      fs.mkdirSync(root, { recursive: true });

      // A large number of UNRELATED files, spread across many directories,
      // that a full-tree walk would have had to visit — well past the old
      // 16,384-file / 4,096-directory caps if this were multiplied out, but
      // kept small here since the point is call-count independence, not
      // hitting the old ceiling literally (the spy below proves that).
      const noiseDirs = 40;
      const filesPerDir = 25;
      for (let d = 0; d < noiseDirs; d++) {
        const dir = path.join(root, "noise", `dir-${d}`);
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < filesPerDir; f++) {
          fs.writeFileSync(path.join(dir, `file-${f}.txt`), "noise");
        }
      }

      // The actual target: a command authored OUTSIDE its canonical
      // `commands/` stash dir (closed-form "loose fallback" class).
      const target = path.join(root, "vendor", "tools", "deploy.md");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "Use $ARGUMENTS exactly.\n");

      const entry: FileContext = {
        absPath: target,
        file: target,
        relPath: "vendor/tools/deploy.md",
        key: "vendor/tools/deploy.md",
        ext: ".md",
        fileName: "deploy.md",
        parentDir: "tools",
        parentDirAbs: path.dirname(target),
        ancestorDirs: ["vendor", "tools"],
        stashRoot: root,
        content: () => fs.readFileSync(target, "utf8"),
        bytes: () => fs.readFileSync(target),
        frontmatter: () => null,
        stat: () => fs.statSync(target),
      };
      const document = akmAdapter.recognize({ id: "akm", root }, entry);
      expect(document?.conceptId).toBe("vendor/tools/deploy");

      const readdirSpy = spyOn(fs, "readdirSync");
      try {
        const owner = findInBundle({ name: "test", path: root }, "akm", "vendor/tools/deploy");
        expect(owner?.entry.file).toBe(target);
      } finally {
        readdirSpy.mockRestore();
      }
      // A handful of `candidateSpellings` parent-directory listings (one per
      // closed-form candidate, plus the workflow-arbitration path for
      // unrelated conceptIds), never a count that scales with the 1,000
      // unrelated noise files/dirs created above.
      expect(readdirSpy.mock.calls.length).toBeLessThan(10);
    } finally {
      sandbox.cleanup();
    }
  });

  test("read cost does not grow with tree size: no content read, at most one git process (10,000 files)", () => {
    const sandbox = sandboxStashDir();
    try {
      const bin = path.join(sandbox.dir, "bin");
      const gitLog = path.join(sandbox.dir, "git-calls.log");
      const realGit = Bun.which("git");
      if (!realGit) throw new Error("git is required for this test");
      fs.mkdirSync(bin, { recursive: true });
      // A `git` on PATH that counts each process the facade starts, then runs the real one.
      fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> "${gitLog}"\nexec "${realGit}" "$@"\n`, {
        mode: 0o755,
      });

      const build = (name: string, files: number): string => {
        const root = path.join(sandbox.dir, name);
        fs.mkdirSync(root, { recursive: true });
        for (let dir = 0; dir < Math.ceil(files / 100); dir++) {
          const folder = path.join(root, "knowledge", `d${dir}`);
          fs.mkdirSync(folder, { recursive: true });
          for (let file = 0; file < 100 && dir * 100 + file < files; file++) {
            fs.writeFileSync(path.join(folder, `f${file}.md`), "# note\n");
          }
        }
        fs.writeFileSync(path.join(root, "knowledge", "d0", "target.md"), "# target\n");
        Bun.spawnSync(["git", "init", "-q"], { cwd: root });
        return root;
      };
      const small = build("small", 100);
      const large = build("large", 10_000);

      const readOnce = (root: string): { ms: number; contentReads: number; gitCalls: number } => {
        fs.rmSync(gitLog, { force: true });
        const originalRead = fs.readFileSync;
        let contentReads = 0;
        const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
          if (String(candidate).startsWith(root)) contentReads += 1;
          return originalRead(candidate, options as never);
        }) as typeof fs.readFileSync);
        const savedPath = process.env.PATH;
        process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
        try {
          const started = performance.now();
          const owner = findInBundle({ name: "test", path: root }, "akm", "knowledge/d0/target");
          const ms = performance.now() - started;
          expect(owner?.entry.file).toBe(path.join(root, "knowledge", "d0", "target.md"));
          const gitCalls = fs.existsSync(gitLog)
            ? fs.readFileSync(gitLog, "utf8").split("\n").filter(Boolean).length
            : 0;
          return { ms, contentReads, gitCalls };
        } finally {
          process.env.PATH = savedPath;
          readSpy.mockRestore();
        }
      };

      const best = (root: string) => {
        const runs = [readOnce(root), readOnce(root), readOnce(root)];
        return { ms: Math.min(...runs.map((run) => run.ms)), runs };
      };
      const smallRun = best(small);
      const largeRun = best(large);
      for (const run of [...smallRun.runs, ...largeRun.runs]) {
        expect(run.contentReads).toBe(0);
        expect(run.gitCalls).toBeLessThanOrEqual(1);
      }
      // 100 times the files, not 100 times the time.
      expect(largeRun.ms).toBeLessThan(Math.max(smallRun.ms * 10, 100));
    } finally {
      sandbox.cleanup();
    }
  });

  test("resolves a canonical AKM command placement", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const canonical = path.join(root, "commands", "greet.md");
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, "# Greet\n");
      const owner = findInBundle({ name: "test", path: root }, "akm", "commands/greet");
      expect(owner?.entry.file).toBe(canonical);
    } finally {
      sandbox.cleanup();
    }
  });

  test("resolves a loose off-canonical AKM command placement (not under commands/)", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const loose = path.join(root, "misc", "greet.md");
      fs.mkdirSync(path.dirname(loose), { recursive: true });
      fs.writeFileSync(loose, "Use $ARGUMENTS exactly.\n");
      const owner = findInBundle({ name: "test", path: root }, "akm", "misc/greet");
      expect(owner?.entry.file).toBe(loose);
    } finally {
      sandbox.cleanup();
    }
  });

  test("two files that invert to the same ref: the spelling place gives wins, for every caller", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
      fs.writeFileSync(path.join(root, "tasks", "same.md"), "# Same note\n");
      fs.writeFileSync(path.join(root, "tasks", "same.yml"), "name: same\n");
      expect(findInBundle({ name: "test", path: root }, "akm", "tasks/same")?.entry.file).toBe(
        path.join(root, "tasks", "same.yml"),
      );
    } finally {
      sandbox.cleanup();
    }
  });

  test("the same collision reads the same winner whatever the caller", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
      const first = path.join(root, "tasks", "same.md");
      fs.writeFileSync(first, "# Same note\n");
      fs.writeFileSync(path.join(root, "tasks", "same.yml"), "name: same\n");

      const owner = findInBundle({ name: "test", path: root }, "akm", "tasks/same");
      expect(owner?.entry.file).toBe(path.join(root, "tasks", "same.yml"));
      expect(first).not.toBe(owner?.entry.file);
    } finally {
      sandbox.cleanup();
    }
  });

  test("env duality — the bare '.env' spelling resolves the 'default' alias (akm adapter)", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const dotEnv = path.join(root, "env", ".env");
      fs.mkdirSync(path.dirname(dotEnv), { recursive: true });
      fs.writeFileSync(dotEnv, "TOKEN=hidden\n");
      const owner = findInBundle({ name: "test", path: root }, "akm", "env/default");
      expect(owner?.entry.file).toBe(dotEnv);
    } finally {
      sandbox.cleanup();
    }
  });

  test("env duality — the '<name>.env' spelling also resolves the 'default' alias (akm adapter)", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const namedEnv = path.join(root, "env", "default.env");
      fs.mkdirSync(path.dirname(namedEnv), { recursive: true });
      fs.writeFileSync(namedEnv, "TOKEN=hidden\n");
      const owner = findInBundle({ name: "test", path: root }, "akm", "env/default");
      expect(owner?.entry.file).toBe(namedEnv);
    } finally {
      sandbox.cleanup();
    }
  });

  test("env duality: when both '.env' and 'default.env' are authored, one wins", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "dotenv");
      const envDir = path.join(root, "env");
      fs.mkdirSync(envDir, { recursive: true });
      fs.writeFileSync(path.join(envDir, ".env"), "TOKEN=hidden\n");
      fs.writeFileSync(path.join(envDir, "default.env"), "TOKEN=hidden\n");
      // `place` gives the bare `.env` for the default.
      expect(findInBundle({ name: "test", path: root }, "dotenv", "env/default")?.entry.file).toBe(
        path.join(envDir, ".env"),
      );
    } finally {
      sandbox.cleanup();
    }
  });

  test("a read of the same env-duality collision gives the same winner", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "dotenv");
      const envDir = path.join(root, "env");
      fs.mkdirSync(envDir, { recursive: true });
      const dotEnv = path.join(envDir, ".env");
      const namedEnv = path.join(envDir, "default.env");
      fs.writeFileSync(dotEnv, "TOKEN=hidden\n");
      fs.writeFileSync(namedEnv, "TOKEN=hidden\n");
      const owner = findInBundle({ name: "test", path: root }, "dotenv", "env/default");
      expect(owner?.entry.file).toBe(dotEnv);
      expect(namedEnv).not.toBe(owner?.entry.file);
    } finally {
      sandbox.cleanup();
    }
  });

  // A `.derived.md` memory is a separate child item: the indexer gives
  // `gate.derived.md` the conceptId `memories/ops/gate.derived`, so ownership
  // must agree. Counting it as a second owner of `memories/ops/gate` made
  // `akm show` of every memory with a derived child fail.
  test("a memory and its .derived.md child each own only the conceptId the indexer gives them", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const bundle = { id: "akm", adapter: "akm", root, writable: false };
      const parent = path.join(root, "memories", "ops", "gate.md");
      const child = path.join(root, "memories", "ops", "gate.derived.md");
      fs.mkdirSync(path.dirname(parent), { recursive: true });
      fs.writeFileSync(parent, "---\ndescription: Parent\n---\nParent body.\n");
      fs.writeFileSync(child, "---\ninferred: true\nsource: memories/ops/gate\n---\nDerived body.\n");

      expect(akmAdapter.recognize(bundle, buildFileContext(root, parent))?.conceptId).toBe("memories/ops/gate");
      expect(akmAdapter.recognize(bundle, buildFileContext(root, child))?.conceptId).toBe("memories/ops/gate.derived");
      expect(findInBundle({ name: "test", path: root }, "akm", "memories/ops/gate")?.entry.file).toBe(parent);
      expect(findInBundle({ name: "test", path: root }, "akm", "memories/ops/gate.derived")?.entry.file).toBe(child);
    } finally {
      sandbox.cleanup();
    }
  });

  test("a derived-only memory does not own its parent's conceptId", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const child = path.join(root, "memories", "ops", "gate.derived.md");
      fs.mkdirSync(path.dirname(child), { recursive: true });
      fs.writeFileSync(child, "---\ninferred: true\nsource: memories/ops/gate\n---\nDerived body.\n");

      expect(findInBundle({ name: "test", path: root }, "akm", "memories/ops/gate")).toBeUndefined();
      expect(findInBundle({ name: "test", path: root }, "akm", "memories/ops/gate.derived")?.entry.file).toBe(child);
    } finally {
      sandbox.cleanup();
    }
  });

  test("dotenv adapter has no loose-fallback candidate class — an off-canonical .env file is not claimed", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "dotenv");
      fs.mkdirSync(root, { recursive: true });
      const loose = path.join(root, "prod.env");
      fs.writeFileSync(loose, "TOKEN=hidden\n");
      expect(findInBundle({ name: "test", path: root }, "dotenv", "prod")).toBeUndefined();
    } finally {
      sandbox.cleanup();
    }
  });
});

// ── The facade: finding, listing, addressing and writing ────────────────────

/** An akm-layout bundle root holding the given files (relative path -> body). */
function bundleOf(id: string, files: Record<string, string>, adapterId = "akm"): TestSource {
  const root = makeSandboxDir(`akm-assets-${id}`);
  sandboxes.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root.dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { bundleId: id, path: root.dir, registryId: id, adapterId };
}

const sandboxes: SandboxedDir[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

/** A writable write target over `source`. */
function targetOf(source: SearchSource, name = source.registryId ?? "bundle", writable = true): ResolvedWriteTarget {
  return {
    source: {
      kind: "filesystem",
      name,
      path: source.path,
      ...(source.adapterId ? { adapterId: source.adapterId } : {}),
    },
    config: { type: "filesystem", name, path: source.path, writable },
  };
}

describe("findAsset", () => {
  test("a qualified ref resolves inside its own bundle, ahead of an earlier bundle that has the same concept", () => {
    const first = bundleOf("first", { "scripts/deploy.sh": "echo first\n" });
    const second = bundleOf("second", { "scripts/deploy.sh": "echo second\n" });

    const found = findAsset("second//scripts/deploy.sh", { sources: [first, second] });

    expect(found?.bundle).toBe("second");
    expect(found?.ref).toBe("second//scripts/deploy.sh");
    expect(found?.entry.file).toBe(path.join(second.path, "scripts", "deploy.sh"));
  });

  test("an unqualified ref resolves to the first source in priority order that holds it", () => {
    const first = bundleOf("first", { "knowledge/only-first.md": "# first\n" });
    const second = bundleOf("second", { "scripts/deploy.sh": "echo second\n" });
    const third = bundleOf("third", { "scripts/deploy.sh": "echo third\n" });

    expect(findAsset("scripts/deploy.sh", { sources: [first, second, third] })?.bundle).toBe("second");
    expect(findAsset("scripts/deploy.sh", { sources: [third, second, first] })?.bundle).toBe("third");
  });

  test("an asset reads as its adapter holds it; its type is the index's, asked for separately", () => {
    const stash = bundleOf("stash", { "knowledge/note.md": "---\ndescription: A note\n---\nBody\n" });

    const found = findAsset("knowledge/note", { sources: [stash] });

    expect(found).toMatchObject({ conceptId: "knowledge/note", bundle: "stash" });
    expect(found).not.toHaveProperty("type");
    expect(found).not.toHaveProperty("listed");
    expect(assetType(found as Asset)).toBe("knowledge");
    expect(found?.entry.frontmatter()).toMatchObject({ description: "A note" });
    expect(found?.entry.content()).toContain("Body");
  });

  test("a `.sensitive` marker left in a bundle is ignored: its env file and secret are found and listed", () => {
    const stash = bundleOf("stash", {
      "env/prod.env": "A=1\n",
      "env/prod.sensitive": "",
      "secrets/token": "s3cret\n",
      "secrets/token.sensitive": "",
    });

    const env = findAsset("env/prod", { sources: [stash] });
    expect(assetType(env as Asset)).toBe("env");
    expect(env?.entry.file).toBe(path.join(stash.path, "env", "prod.env"));
    expect(assetType(findAsset("secrets/token", { sources: [stash] }) as Asset)).toBe("secret");
    expect(listAssets({ sources: [stash] }).map((asset) => asset.ref)).toEqual([
      "stash//env/prod",
      "stash//secrets/token",
    ]);
  });

  test("nothing is found for a missing concept or an unknown bundle", () => {
    const stash = bundleOf("stash", { "scripts/deploy.sh": "echo\n" });

    expect(findAsset("scripts/missing.sh", { sources: [stash] })).toBeUndefined();
    expect(findAsset("nobody//scripts/deploy.sh", { sources: [stash] })).toBeUndefined();
  });

  test("requireAsset refuses a ref no bundle holds with a not-found error", () => {
    const stash = bundleOf("stash", {});
    expect(() => requireAsset("knowledge/none", { sources: [stash] })).toThrow(NotFoundError);
  });

  test("two files holding one ref read as one winner, the same for every caller", () => {
    const stash = bundleOf("stash", { "tasks/same.md": "# Same note\n", "tasks/same.yml": "name: same\n" });

    expect(findAsset("tasks/same", { sources: [stash] })?.entry.file).toBe(path.join(stash.path, "tasks", "same.yml"));
  });

  test("every spelling of a ref reads the asset under its one canonical ref", () => {
    const stash = bundleOf("stash", {
      "knowledge/guide.md": "# Guide\n",
      "tasks/nightly.yml": "name: nightly\n",
      "scripts/deploy.sh": "echo\n",
    });

    for (const [spelling, canonical] of [
      ["knowledge/guide", "knowledge/guide"],
      ["knowledge/guide.md", "knowledge/guide"],
      ["tasks/nightly", "tasks/nightly"],
      ["tasks/nightly.yml", "tasks/nightly"],
      ["scripts/deploy.sh", "scripts/deploy.sh"],
    ] as const) {
      const found = findAsset(spelling, { sources: [stash] });
      expect(found?.conceptId).toBe(canonical);
      expect(found?.ref).toBe(`stash//${canonical}`);
    }
    expect(listAssets({ sources: [stash] }).map((asset) => asset.ref)).toEqual([
      "stash//knowledge/guide",
      "stash//scripts/deploy.sh",
      "stash//tasks/nightly",
    ]);
  });

  test("a ref in the outdated type-folder spelling finds the asset, with one warning", () => {
    const stash = bundleOf("stash", { "reports/x.md": "# Report\n" });
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      expect(findAsset("knowledge/reports/x", { sources: [stash] })?.conceptId).toBe("reports/x");
      expect(findAsset("knowledge/reports/x", { sources: [stash] })?.conceptId).toBe("reports/x");
    } finally {
      _setWarnSinkForTests(undefined);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"knowledge\/reports\/x" is outdated.*"reports\/x"/);
  });
});

describe("listAssets, currentConceptId, assetRevision", () => {
  test("lists the assets of a type across bundles, in the bundles' order and then by name", () => {
    const first = bundleOf("first", {
      "secrets/b": "1",
      "secrets/a": "2",
      "knowledge/k.md": "# k\n",
    });
    const second = bundleOf("second", { "secrets/a": "3" });

    const secrets = listAssets({ sources: [first, second], type: "secret" });

    expect(secrets.map((asset) => asset.ref)).toEqual(["first//secrets/a", "first//secrets/b", "second//secrets/a"]);
    expect(listAssets({ sources: [second, first], type: "secret" }).map((asset) => asset.ref)).toEqual([
      "second//secrets/a",
      "first//secrets/a",
      "first//secrets/b",
    ]);
    expect(listAssets({ sources: [first, second], bundle: "second" }).map((asset) => asset.ref)).toEqual([
      "second//secrets/a",
    ]);
  });

  test("currentConceptId maps an outdated spelling to the asset's ref, and leaves any other as written", () => {
    const stash = bundleOf("stash", { "reports/x.md": "# Report\n" });
    expect(currentConceptId({ conceptId: "knowledge/reports/x" }, [stash])).toBe("reports/x");
    expect(currentConceptId({ conceptId: "reports/x" }, [stash])).toBe("reports/x");
    expect(currentConceptId({ conceptId: "reports/none" }, [stash])).toBe("reports/none");
  });

  test("a revision is the sha256 of the content, as text or bytes", () => {
    expect(assetRevision("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(assetRevision(Buffer.from("abc"))).toBe(assetRevision("abc"));
  });
});

describe("addressOf", () => {
  test("an existing asset is addressed by its ref, wherever its file sits, and takes its type from it", () => {
    const stash = bundleOf("stash", { "reports/release.md": "# Release\n" });
    const source = { name: "stash", path: stash.path };

    expect(addressOf(source, "reports/release")).toEqual({
      conceptId: "reports/release",
      type: "knowledge",
      name: "reports/release",
      exists: true,
      file: path.join(stash.path, "reports", "release.md"),
    });
    expect(addressOf(source, "stash//knowledge/reports/release")).toMatchObject({
      conceptId: "reports/release",
      exists: true,
    });
  });

  test("a new asset is placed by its adapter in its ref's type folder", () => {
    const stash = bundleOf("stash", {});

    expect(addressOf({ name: "stash", path: stash.path }, "lessons/new-one")).toEqual({
      conceptId: "lessons/new-one",
      type: "lesson",
      name: "new-one",
      exists: false,
      file: path.join(stash.path, "lessons", "new-one.md"),
    });
  });

  test("a bundle whose adapter does not write is not refused by addressOf: no file is placed, the write refuses", () => {
    const okf = bundleOf("okf", {}, "okf");
    expect(addressOf({ name: "okf", path: okf.path, adapterId: "okf" }, "lessons/new-one")).toEqual({
      conceptId: "lessons/new-one",
      type: "lesson",
      name: "new-one",
      exists: false,
    });
    // The write session's address is a write's own gate.
    expect(() => writeAssets(targetOf(okf, "okf"), { purpose: "test" }, (w) => w.address("lessons/new-one"))).toThrow(
      /adapter "okf", which does not support AKM asset writes/,
    );
  });

  test("a name the adapter would place where no asset is: addressOf names it as written, the write session refuses", () => {
    const stash = bundleOf("stash", {});
    const source = { name: "stash", path: stash.path };
    expect(addressOf(source, "scripts/no-extension")).toMatchObject({
      conceptId: "scripts/no-extension",
      exists: false,
    });
    expect(() =>
      writeAssets(targetOf(stash, "stash"), { purpose: "test" }, (w) => w.address("scripts/no-extension")),
    ).toThrow(/which is not an asset/);
  });
});

describe("writeAssets", () => {
  test("creates, reads, updates and deletes an asset through the bundle's adapter", () => {
    const stash = bundleOf("stash", {});
    const target = targetOf(stash);

    const created = writeAssets(target, { purpose: "test" }, (w) =>
      w.create({ type: "knowledge", name: "note", content: "---\ndescription: n\n---\nBody\n" }),
    );
    expect(created).toEqual({
      ref: "stash//knowledge/note",
      content: "---\ndescription: n\n---\nBody\n",
    });
    expect(fs.existsSync(path.join(stash.path, "knowledge", "note.md"))).toBe(true);

    writeAssets(target, { purpose: "test" }, (w) => {
      expect(assetType(w.read("knowledge/note") as Asset)).toBe("knowledge");
      w.update("knowledge/note", "---\ndescription: n\n---\nChanged\n");
    });
    expect(fs.readFileSync(path.join(stash.path, "knowledge", "note.md"), "utf8")).toContain("Changed");

    const deleted = writeAssets(target, { purpose: "test" }, (w) => w.delete("knowledge/note"));
    expect(deleted).toEqual({ ref: "stash//knowledge/note" });
    expect(fs.existsSync(path.join(stash.path, "knowledge", "note.md"))).toBe(false);
  });

  test("a create over an existing asset writes what a create writes, not the bare content", () => {
    const stash = bundleOf("stash", {});
    const target = targetOf(stash);
    const create = (name: string, content: string) =>
      writeAssets(target, { purpose: "test" }, (w) => w.create({ type: "knowledge", name, content }));

    create("again", "first\n");
    create("again", "Second body");
    create("fresh", "Second body");

    const bytes = (name: string) => fs.readFileSync(path.join(stash.path, "knowledge", `${name}.md`), "utf8");
    expect(bytes("again")).toBe(bytes("fresh"));
    expect(bytes("again")).toContain("Second body");
    expect(bytes("again")).not.toContain("first");
  });

  test("a verbatim create keeps the content exactly, and an exclusive one still refuses an existing asset", () => {
    const stash = bundleOf("stash", {});
    const target = targetOf(stash);
    writeAssets(target, { purpose: "test" }, (w) =>
      w.create({ type: "knowledge", name: "exact", content: "no frontmatter\n" }, { verbatim: true }),
    );
    expect(fs.readFileSync(path.join(stash.path, "knowledge", "exact.md"), "utf8")).toBe("no frontmatter\n");
    expect(() =>
      writeAssets(target, { purpose: "test" }, (w) =>
        w.create({ type: "knowledge", name: "exact", content: "x\n" }, { exclusive: true, verbatim: true }),
      ),
    ).toThrow(UsageError);
  });

  test("a source that is not writable is refused first", () => {
    const stash = bundleOf("stash", {});
    expect(() =>
      writeAssets(targetOf(stash, "stash", false), { purpose: "test" }, (w) =>
        w.create({ type: "knowledge", name: "note", content: "x" }),
      ),
    ).toThrow('Source "stash" is not writable.');
  });

  test("an adapter that writes nothing is refused with its sentence", () => {
    const okf = bundleOf("okf", { "pages/a.md": "# a\n" }, "okf");
    expect(() =>
      writeAssets(targetOf(okf), { purpose: "test" }, (w) =>
        w.create({ type: "knowledge", name: "note", content: "x" }),
      ),
    ).toThrow('Bundle "okf" uses adapter "okf", which does not support AKM asset writes.');
  });

  test("an adapter that does not write a type is refused with its sentence, for a create and for a change", () => {
    const dotenv = bundleOf("env-only", { "env/prod.env": "A=1\n" }, "dotenv");
    const target = targetOf(dotenv);
    expect(() =>
      writeAssets(target, { purpose: "test" }, (w) => w.create({ type: "knowledge", name: "note", content: "x" })),
    ).toThrow('Bundle "env-only" uses adapter "dotenv", which does not support AKM asset writes.');
    expect(writeAssets(target, { purpose: "test" }, (w) => w.update("env/prod", "A=2\n")).ref).toBe(
      "env-only//env/prod",
    );
  });

  test("an asset the bundle does not hold is not found", () => {
    const stash = bundleOf("stash", {});
    expect(() => writeAssets(targetOf(stash), { purpose: "test" }, (w) => w.update("knowledge/none", "x"))).toThrow(
      "Asset not found: stash//knowledge/none",
    );
  });

  test("a type the adapter does not retire is refused when retired, with its sentence", () => {
    const stash = bundleOf("stash", { "env/prod.env": "A=1\n", "memories/m.md": "---\ndescription: m\n---\nm\n" });
    const target = targetOf(stash);
    expect(() => writeAssets(target, { purpose: "test" }, (w) => w.retire("env/prod", {}))).toThrow(
      'Bundle "stash" uses adapter "akm", which does not support AKM asset writes.',
    );
    const [retired, ...others] = writeAssets(target, { purpose: "test" }, (w) => {
      const changes = w.retire("memories/m", { reason: "test" });
      expect(w.retired().map((r) => r.conceptId)).toEqual(["memories/m"]);
      return changes;
    });
    if (!retired) throw new Error("no retirement");
    expect(others).toEqual([]);
    expect(retired).toEqual({ ref: "stash//memories/m", handle: expect.any(String) });
    expect(fs.existsSync(path.join(stash.path, "memories", "m.md"))).toBe(false);
    writeAssets(target, { purpose: "test" }, (w) => w.restore(retired.handle));
    expect(fs.existsSync(path.join(stash.path, "memories", "m.md"))).toBe(true);
  });

  test("an exclusive create refuses an asset that exists", () => {
    const stash = bundleOf("stash", { "knowledge/note.md": "---\ndescription: n\n---\nx\n" });
    expect(() =>
      writeAssets(targetOf(stash), { purpose: "test" }, (w) =>
        w.create({ type: "knowledge", name: "note", content: "y" }, { exclusive: true }),
      ),
    ).toThrow('Asset "stash//knowledge/note" already exists.');
  });

  test("a change names the revision it read, and is refused when the asset changed since", () => {
    const stash = bundleOf("stash", { "knowledge/note.md": "line\n" });
    const target = targetOf(stash);
    const revision = assetRevision("line\n");

    writeAssets(target, { purpose: "test" }, (w) => w.update("knowledge/note", "next\n", { revision }));
    expect(() =>
      writeAssets(target, { purpose: "test" }, (w) => w.update("knowledge/note", "again\n", { revision })),
    ).toThrow('Asset "stash//knowledge/note" changed since it was read; the change was not applied.');
    expect(() => writeAssets(target, { purpose: "test" }, (w) => w.delete("knowledge/note", { revision }))).toThrow(
      UsageError,
    );
  });

  test("a change to the outdated type-folder spelling of a ref is made to the asset a read of it finds", () => {
    const body = "---\ndescription: r\n---\nfirst\n";
    const stash = bundleOf("stash", { "reports/x.md": body });
    const target = targetOf(stash);
    const write = <T>(run: (w: facadeWrite.AssetWriter) => T): T => writeAssets(target, { purpose: "test" }, run);
    const file = path.join(stash.path, "reports", "x.md");
    const outdated = "knowledge/reports/x";
    const twin = path.join(stash.path, "knowledge");

    expect(write((w) => w.read(outdated)?.conceptId)).toBe("reports/x");
    // The revision is the resolved asset's: a stale one is refused and nothing is written anywhere.
    expect(() => write((w) => w.update(outdated, "next\n", { revision: assetRevision("stale\n") }))).toThrow(
      'Asset "stash//reports/x" changed since it was read; the change was not applied.',
    );
    expect(fs.readFileSync(file, "utf8")).toBe(body);
    expect(
      write((w) => w.update(outdated, "---\ndescription: r\n---\nsecond\n", { revision: assetRevision(body) })),
    ).toMatchObject({ ref: "stash//reports/x" });
    expect(fs.readFileSync(file, "utf8")).toContain("second");

    const [retired] = write((w) => w.retire(outdated, { reason: "test" }));
    expect(retired).toEqual({ ref: "stash//reports/x", handle: expect.any(String) });
    expect(fs.existsSync(file)).toBe(false);
    write((w) => w.restore((retired as { handle: string }).handle));
    expect(fs.readFileSync(file, "utf8")).toContain("second");

    expect(write((w) => w.delete(outdated))).toEqual({ ref: "stash//reports/x" });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(twin)).toBe(false);
  });

  test("the address of an existing asset and of a new one", () => {
    const stash = bundleOf("stash", { "reports/r.md": "# r\n" });
    writeAssets(targetOf(stash), { purpose: "test" }, (w) => {
      expect(w.address("reports/r")).toMatchObject({ exists: true, type: "knowledge", conceptId: "reports/r" });
      expect(w.address("lessons/fresh")).toMatchObject({ exists: false, type: "lesson", conceptId: "lessons/fresh" });
    });
  });

  test("the session's changes are recorded as written paths", () => {
    const stash = bundleOf("stash", {});
    const journal = beginWriteProvenance();
    try {
      writeAssets(targetOf(stash), { purpose: "test" }, (w) =>
        w.create({ type: "knowledge", name: "note", content: "x" }),
      );
      expect(journal.writtenPaths()).toContain(path.join(stash.path, "knowledge", "note.md"));
    } finally {
      journal.end();
    }
  });
});

describe("a keyring bundle behind the facade", () => {
  test("its secrets are found, listed, written and deleted as a directory bundle's are", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({
        semanticSearchMode: "off",
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          keyring: { adapter: "secret-tool", location: "akm" },
        },
        defaultBundle: "stash",
      });
      await withFakeSecretStores(
        {
          keyrings: {
            akm: [
              {
                path: "/org/freedesktop/secrets/collection/akm/1",
                label: "gh_token",
                attributes: { akm: "akm/gh_token" },
                secret: "ghp-value",
              },
            ],
          },
        },
        async () => {
          await akmIndex({ stashDir: storage.stashDir, full: true });
          const source = resolveSourceEntries(undefined, loadConfig()).find((source) => source.bundleId === "keyring");
          expect(source).toBeDefined();
          expect(source?.path).toBeUndefined();
          const found = findAsset("keyring//secrets/gh_token");
          expect(found).toMatchObject({ bundle: "keyring" });
          expect(assetType(found as Asset)).toBe("secret");
          expect(found?.entry.file).toBeUndefined();
          expect(found?.entry.content()).toBe("ghp-value");
          expect(facade.listAssets({ type: "secret" }).map((asset) => asset.ref)).toEqual([
            "keyring//secrets/gh_token",
          ]);

          const target = resolveWriteTarget(loadConfig(), "keyring");
          expect(target.source.path).toBeUndefined();
          writeAssets(target, { purpose: "test" }, (w) => w.create({ type: "secret", name: "other", content: "v2" }));
          expect(findAsset("keyring//secrets/other")?.entry.content()).toBe("v2");
          writeAssets(target, { purpose: "test" }, (w) => w.delete("secrets/other"));
          expect(findAsset("keyring//secrets/other")).toBeUndefined();
          expect(() =>
            writeAssets(target, { purpose: "test" }, (w) => w.create({ type: "knowledge", name: "k", content: "x" })),
          ).toThrow('Bundle "keyring" uses adapter "secret-tool", which does not support AKM asset writes.');
          expect(() => writeAssets(target, { purpose: "test" }, (w) => w.retire("secrets/gh_token", {}))).toThrow(
            "which does not support AKM asset writes.",
          );
        },
      );
    } finally {
      storage.cleanup();
    }
  });
});

describe("assetType", () => {
  /** The index's row for `ref`, or undefined. */
  function indexedType(ref: string): string | undefined {
    const db = openExistingDatabase(getDbPath());
    try {
      return (db.prepare("SELECT type FROM entries WHERE item_ref = ?").get(ref) as { type: string } | undefined)?.type;
    } finally {
      closeDatabase(db);
    }
  }

  test("reads the type from the index, and a file added outside akm is indexed on the first ask", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "main",
        bundles: { main: { path: storage.stashDir, writable: true } },
      });
      resetConfigCache();
      fs.mkdirSync(path.join(storage.stashDir, "knowledge"), { recursive: true });
      fs.writeFileSync(path.join(storage.stashDir, "knowledge", "known.md"), "# known\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(indexedType("main//knowledge/known")).toBe("knowledge");

      // Added by hand after the index was built: the index has no row for it.
      const added = path.join(storage.stashDir, "commands", "added.md");
      fs.mkdirSync(path.dirname(added), { recursive: true });
      fs.writeFileSync(added, "Use $ARGUMENTS exactly.\n");
      expect(indexedType("main//commands/added")).toBeUndefined();

      const asset = findAsset("main//commands/added") as Asset;
      expect(asset.entry.file).toBe(added);
      expect(assetType(asset)).toBe("command");
      // The ask recorded the row; the next one reads the index and not the file.
      expect(indexedType("main//commands/added")).toBe("command");
      const original = fs.readFileSync;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
        if (path.resolve(String(candidate)) === added) throw new Error("the type of an indexed asset must not be read");
        return original(candidate, options as never);
      }) as typeof fs.readFileSync);
      try {
        expect(assetType(asset)).toBe("command");
        expect(assetType(findAsset("main//knowledge/known") as Asset)).toBe("knowledge");
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      storage.cleanup();
    }
  });

  test("with no index at all it says what the adapter says, and builds none", () => {
    // Its own data directory: the process-wide one holds the index an earlier test file in the same run built.
    const storage = withIsolatedAkmStorage();
    try {
      const stash = bundleOf("stash", { "knowledge/a.md": "# a\n", "env/prod.env": "A=1\n" });
      expect(assetType(findAsset("knowledge/a", { sources: [stash] }) as Asset)).toBe("knowledge");
      expect(assetType(findAsset("env/prod", { sources: [stash] }) as Asset)).toBe("env");
      expect(fs.existsSync(getDbPath())).toBe(false);
    } finally {
      storage.cleanup();
    }
  });
});

describe("assetTypeFresh", () => {
  test("a file edited outside akm is typed by its content now, and the row follows", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "main",
        bundles: { main: { path: storage.stashDir, writable: true } },
      });
      resetConfigCache();
      const note = path.join(storage.stashDir, "knowledge", "note.md");
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(note, "# note\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const asset = findAsset("main//knowledge/note") as Asset;
      expect(assetTypeFresh(asset)).toBe("knowledge");

      // Edited by hand: the index still says what it said, and the gate that runs the asset does not.
      fs.writeFileSync(note, "---\nagent: build\n---\nBuild $ARGUMENTS.\n");
      const edited = findAsset("main//knowledge/note") as Asset;
      expect(assetType(edited)).toBe("knowledge");
      expect(assetTypeFresh(edited)).toBe("command");
      expect(assetType(edited)).toBe("command");
    } finally {
      storage.cleanup();
    }
  });
});

describe("assetType and an index an older adapter version wrote", () => {
  test("a row described by another adapter version is described again, for that one ref", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "main",
        bundles: { main: { path: storage.stashDir, writable: true } },
      });
      resetConfigCache();
      fs.mkdirSync(path.join(storage.stashDir, "knowledge"), { recursive: true });
      fs.writeFileSync(path.join(storage.stashDir, "knowledge", "a.md"), "# a\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const db = openExistingDatabase(getDbPath());
      try {
        db.prepare("UPDATE entries SET type = 'stale' WHERE item_ref = 'main//knowledge/a'").run();
        db.prepare(
          "INSERT OR REPLACE INTO index_meta (key, value) SELECT 'variant:' || bundle_id, 'akm@0.0.1+content1' FROM entries GROUP BY bundle_id",
        ).run();
      } finally {
        closeDatabase(db);
      }
      const asset = findAsset("main//knowledge/a") as Asset;
      expect(assetType(asset)).toBe("knowledge");
      const check = openExistingDatabase(getDbPath());
      try {
        expect(
          (check.prepare("SELECT type FROM entries WHERE item_ref = 'main//knowledge/a'").get() as { type: string })
            .type,
        ).toBe("knowledge");
      } finally {
        closeDatabase(check);
      }
    } finally {
      storage.cleanup();
    }
  });
});

describe("the directory adapter's writes", () => {
  test("update names the asset by its canonical concept id, and create refuses one that exists", () => {
    const stash = bundleOf("stash", { "knowledge/a.md": "# a\n" });
    const bundle = { id: "stash", root: stash.path };
    expect(akmAdapter.update(bundle, "knowledge/a.md", "# b\n").conceptId).toBe("knowledge/a");
    expect(() => akmAdapter.create(bundle, { type: "knowledge", name: "a", content: "x" })).toThrow(
      /over an existing asset/,
    );
  });
});

describe("deleting a package", () => {
  test("every asset of the package leaves search at once, not at the next index", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "main",
        bundles: { main: { path: storage.stashDir, writable: true } },
      });
      resetConfigCache();
      const skill = path.join(storage.stashDir, "skills", "deploy");
      fs.mkdirSync(path.join(skill, "references"), { recursive: true });
      fs.writeFileSync(
        path.join(skill, "SKILL.md"),
        "---\nname: deploy\ndescription: quartz deploy\n---\nquartz steps\n",
      );
      fs.writeFileSync(path.join(skill, "references", "guide.md"), "# Guide\n\nquartz guide\n");
      fs.mkdirSync(path.join(storage.stashDir, "knowledge"), { recursive: true });
      fs.writeFileSync(path.join(storage.stashDir, "knowledge", "other.md"), "# Other\n\nquartz other\n");
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const refs = async () =>
        (await akmSearch({ query: "quartz", skipLogging: true, limit: 20 })).hits
          .map((hit) => ("ref" in hit ? String(hit.ref) : ""))
          .sort();
      expect(await refs()).toEqual(["knowledge/other", "skills/deploy", "skills/deploy/references/guide"]);

      const target = resolveWriteTarget(loadConfig(), "main");
      writeAssets(target, { purpose: "test" }, (w) => w.delete("skills/deploy"));

      expect(fs.existsSync(skill)).toBe(false);
      expect(await refs()).toEqual(["knowledge/other"]);
    } finally {
      storage.cleanup();
    }
  });
});
