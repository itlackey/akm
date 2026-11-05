import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { codeProjectAdapter, eligibleType } from "../../../src/core/adapter/adapters/code-project-adapter";
import type { BundleComponent, ValidateContext } from "../../../src/core/adapter/types";
import { buildFileContext, type FileContext } from "../../../src/indexer/walk/file-context";
import { walkStashFlat } from "../../../src/indexer/walk/walker";

const ROOT = path.join(import.meta.dir, "../../fixtures/bundles/code-project");
const GOLDEN = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, "../../fixtures/format-family-goldens/code-project/recognition.json"),
    "utf8",
  ),
) as { byRelPath: Record<string, { type: string; ref: string; name: string; tags?: string[] }> };
const component: BundleComponent = { id: "sample-project", adapter: "code-project", root: ROOT, writable: false };

describe("code-project eligibility", () => {
  test.each([
    ["src/a.ts", "source"],
    ["a/b/c.PY", "source"],
    ["README.md", "doc"],
    ["docs/index.md", "doc"],
    [".github/AGENTS.md", "doc"],
    [".agents/skills/x.md", "doc"],
    ["package.json", "config"],
    ["tsconfig.build.json", "config"],
    ["Dockerfile", "config"],
    ["src/env/config.ts", "source"],
  ])("%s is %s", (rel, type) => expect(eligibleType(rel)).toBe(type as never));

  test.each([
    "image.png",
    "archive.zip",
    "data.json",
    "app.min.js",
    "app.js.map",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lock",
    "go.sum",
    ".env",
    ".env.local",
    "server.pem",
    "id_rsa",
    "dist/out.js",
    "build/x.ts",
    "src/vendor/x.go",
    "secrets/key.ts",
    "env/lib/x.py",
    ".venv/lib/x.py",
    "LICENSE",
  ])("%s is not eligible", (rel) => expect(eligibleType(rel)).toBeUndefined());
});

describe("code-project recognize", () => {
  test("abstains on an ineligible path without reading content", () => {
    const base = buildFileContext(ROOT, path.join(ROOT, "README.md"));
    const refuse = (): never => {
      throw new Error("content read");
    };
    const file: FileContext = {
      ...base,
      relPath: "assets/logo.png",
      ext: ".png",
      content: refuse,
      frontmatter: refuse,
    };
    expect(codeProjectAdapter.recognize(component, file)).toBeNull();
  });

  test("recognizes the fixture exactly as the golden", () => {
    const got: Record<string, unknown> = {};
    for (const file of walkStashFlat(ROOT, { includeAllDirectories: true })) {
      const doc = codeProjectAdapter.recognize(component, file);
      if (doc) {
        got[file.relPath] = {
          type: doc.type,
          ref: doc.ref,
          name: doc.name,
          ...(doc.tags ? { tags: doc.tags } : {}),
        };
        expect(doc.ownsPresentation).toBe(true);
        expect(doc.adapterId).toBe("code-project");
      }
    }
    expect(got).toEqual(GOLDEN.byRelPath);
  });

  test("does not parse frontmatter on non-Markdown files", () => {
    const base = buildFileContext(ROOT, path.join(ROOT, "package.json"));
    const file: FileContext = { ...base, relPath: "ci.toml", ext: ".toml", content: () => "---\nkey: v\n---\nbody" };
    // `ci.toml` is not an eligible name; use a named config file to reach content.
    const cfg: FileContext = { ...file, relPath: "package.json", ext: ".json" };
    expect(codeProjectAdapter.recognize(component, cfg)?.content).toBe("---\nkey: v\n---\nbody");
  });

  test("readCandidates is the identity inversion", () => {
    expect(codeProjectAdapter.readCandidates?.(component, "src/auth/oauth.ts")).toEqual([
      { path: path.join(ROOT, "src/auth/oauth.ts"), conceptId: "src/auth/oauth.ts" },
    ]);
    expect(codeProjectAdapter.looksLikeRoot).toBeUndefined();
  });
});

describe("code-project validate", () => {
  const ctx: ValidateContext = {
    readFile: async () => null,
    list: async () => [],
    resolveRef: async () => ({ exists: false }),
  };

  test("base checks do not run on source (no stale-path or ref misfires)", async () => {
    const diagnostics = await codeProjectAdapter.validate(
      component,
      [
        { path: "src/a.ts", op: "update", after: 'const p = "/tmp/x";' },
        { path: "src/b.py", op: "update", after: "y = x//2" },
      ],
      ctx,
    );
    expect(diagnostics).toEqual([]);
  });
});
