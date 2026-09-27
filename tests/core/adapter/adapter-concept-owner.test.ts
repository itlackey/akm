// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression + closed-form coverage for #857.
 *
 * `resolveAdapterConceptOwner` used to walk the ENTIRE bundle root on every
 * single-ref lookup (`scanRegularAuthoredPaths`/`scannedReadCandidates`,
 * capped at 16,384 files / 4,096 directories), throwing
 * `AdapterConceptScanError` past the cap — a hard operational wall on any
 * bundle bigger than the cap (issue #857). That walk is gone: each adapter's
 * `readCandidates` now enumerates the CLOSED-FORM set of physical spellings a
 * conceptId could own directly (canonical, loose off-canonical, and any
 * type-specific duality), so lookups cost a small, bundle-size-INDEPENDENT
 * number of `readdirSync` calls (`candidateSpellings`'s per-candidate parent
 * listing), never a walk.
 */

import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmAdapter } from "../../../src/core/adapter/adapters/akm-adapter";
import { dotenvAdapter } from "../../../src/core/adapter/adapters/dotenv-adapter";
import {
  AdapterConceptCollisionError,
  resolveAdapterConceptOwner,
} from "../../../src/indexer/lookup/adapter-concept-owner";
import { buildFileContext } from "../../../src/indexer/walk/file-context";
import { sandboxStashDir } from "../../_helpers/sandbox";

describe("resolveAdapterConceptOwner — closed-form candidates (#857)", () => {
  test("readCandidates for a nested-off-canonical conceptId resolves without any readdirSync count growing with unrelated tree size", () => {
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

      const document = akmAdapter.recognize(
        { id: "akm", adapter: "akm", root, writable: false },
        {
          absPath: target,
          relPath: "vendor/tools/deploy.md",
          ext: ".md",
          fileName: "deploy.md",
          parentDir: "tools",
          parentDirAbs: path.dirname(target),
          ancestorDirs: ["vendor", "tools"],
          stashRoot: root,
          content: () => fs.readFileSync(target, "utf8"),
          frontmatter: () => null,
          stat: () => fs.statSync(target),
        },
      );
      expect(document?.conceptId).toBe("commands/vendor/tools/deploy");

      const readdirSpy = spyOn(fs, "readdirSync");
      try {
        const owner = resolveAdapterConceptOwner(root, "akm", "commands/vendor/tools/deploy");
        expect(owner?.path).toBe(target);
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

  test("resolves a canonical AKM command placement", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const canonical = path.join(root, "commands", "greet.md");
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, "# Greet\n");
      const owner = resolveAdapterConceptOwner(root, "akm", "commands/greet");
      expect(owner?.path).toBe(canonical);
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
      const owner = resolveAdapterConceptOwner(root, "akm", "commands/misc/greet");
      expect(owner?.path).toBe(loose);
    } finally {
      sandbox.cleanup();
    }
  });

  test("canonical and loose placements for the same conceptId collide (default: write)", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const loose = path.join(root, "same.md");
      const canonical = path.join(root, "commands", "same.md");
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(loose, "Use $ARGUMENTS exactly.\n");
      fs.writeFileSync(canonical, "# Same command\n");
      expect(() => resolveAdapterConceptOwner(root, "akm", "commands/same")).toThrow(AdapterConceptCollisionError);
    } finally {
      sandbox.cleanup();
    }
  });

  test("an explicit read resolves the same collision to the first owner instead of aborting", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "akm");
      const loose = path.join(root, "same.md");
      const canonical = path.join(root, "commands", "same.md");
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(loose, "Use $ARGUMENTS exactly.\n");
      fs.writeFileSync(canonical, "# Same command\n");

      const owner = resolveAdapterConceptOwner(root, "akm", "commands/same", { mode: "read" });
      expect(owner?.path).toBe(canonical);
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
      const owner = resolveAdapterConceptOwner(root, "akm", "env/default");
      expect(owner?.path).toBe(dotEnv);
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
      const owner = resolveAdapterConceptOwner(root, "akm", "env/default");
      expect(owner?.path).toBe(namedEnv);
    } finally {
      sandbox.cleanup();
    }
  });

  test("env duality collides when both '.env' and 'default.env' are authored together (default: write)", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "dotenv");
      const envDir = path.join(root, "env");
      fs.mkdirSync(envDir, { recursive: true });
      fs.writeFileSync(path.join(envDir, ".env"), "TOKEN=hidden\n");
      fs.writeFileSync(path.join(envDir, "default.env"), "TOKEN=hidden\n");
      expect(() => resolveAdapterConceptOwner(root, "dotenv", "env/default")).toThrow(AdapterConceptCollisionError);
    } finally {
      sandbox.cleanup();
    }
  });

  test("an explicit read resolves the same env-duality collision to the first owner", () => {
    const sandbox = sandboxStashDir();
    try {
      const root = path.join(sandbox.dir, "dotenv");
      const envDir = path.join(root, "env");
      fs.mkdirSync(envDir, { recursive: true });
      const dotEnv = path.join(envDir, ".env");
      const namedEnv = path.join(envDir, "default.env");
      fs.writeFileSync(dotEnv, "TOKEN=hidden\n");
      fs.writeFileSync(namedEnv, "TOKEN=hidden\n");
      const owner = resolveAdapterConceptOwner(root, "dotenv", "env/default", { mode: "read" });
      expect(owner?.path).toBe(dotEnv);
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
      const component = { id: "akm", adapter: "akm", root, writable: false };
      const parent = path.join(root, "memories", "ops", "gate.md");
      const child = path.join(root, "memories", "ops", "gate.derived.md");
      fs.mkdirSync(path.dirname(parent), { recursive: true });
      fs.writeFileSync(parent, "---\ndescription: Parent\n---\nParent body.\n");
      fs.writeFileSync(child, "---\ninferred: true\nsource: memories/ops/gate\n---\nDerived body.\n");

      expect(akmAdapter.recognize(component, buildFileContext(root, parent))?.conceptId).toBe("memories/ops/gate");
      expect(akmAdapter.recognize(component, buildFileContext(root, child))?.conceptId).toBe(
        "memories/ops/gate.derived",
      );
      expect(resolveAdapterConceptOwner(root, "akm", "memories/ops/gate")?.path).toBe(parent);
      expect(resolveAdapterConceptOwner(root, "akm", "memories/ops/gate.derived")?.path).toBe(child);
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

      expect(resolveAdapterConceptOwner(root, "akm", "memories/ops/gate")).toBeUndefined();
      expect(resolveAdapterConceptOwner(root, "akm", "memories/ops/gate.derived")?.path).toBe(child);
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
      expect(
        dotenvAdapter.readCandidates?.({ id: "dotenv", adapter: "dotenv", root, writable: false }, "prod"),
      ).toEqual([]);
    } finally {
      sandbox.cleanup();
    }
  });
});
