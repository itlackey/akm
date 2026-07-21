import { describe, expect, test } from "bun:test";
import {
  BUNDLE_REF_RE,
  type BundleRef,
  bundleRefToString,
  makeBundleRef,
  parseBundleRef,
} from "../src/core/asset/asset-ref";

// ── Bundle-scoped ref grammar (0.9.0, spec §11.1) ────────────────────────────
//
// The `[bundle//]conceptId[#fragment]` grammar is the SOLE ref grammar after
// the Chunk-5 flip closed (F5). `type` is no longer part of identity; the ref
// is a bundle-scoped path id. The pre-0.9.0 `[origin//]type:name` grammar and
// its `parseAssetRef`/`makeAssetRef`/`refToString` API were deleted here and
// relocated to `src/migrate/legacy-ref-grammar.ts` (Chunk-8 content migration
// + the §11.4 re-key). The grammar-invariant intents that survived — name
// validation (empty / null-byte / absolute / traversal / drive-letter),
// backslash normalization, origin↔bundle boundary, and round-trip — are all
// preserved below against the surviving bundle API.

describe("makeBundleRef", () => {
  test("short form — no bundle", () => {
    expect(makeBundleRef(undefined, "knowledge/http-caching")).toBe("knowledge/http-caching");
  });

  test("fully-qualified with bundle", () => {
    expect(makeBundleRef("core", "knowledge/http-caching")).toBe("core//knowledge/http-caching");
  });

  test("with export fragment", () => {
    expect(makeBundleRef("core", "skills/review", "usage")).toBe("core//skills/review#usage");
  });

  test("short form with fragment", () => {
    expect(makeBundleRef(undefined, "skills/review", "usage")).toBe("skills/review#usage");
  });

  test("script conceptId keeps its extension", () => {
    expect(makeBundleRef("kit", "scripts/deploy.sh")).toBe("kit//scripts/deploy.sh");
  });

  test("nested conceptId — slashes stay literal", () => {
    expect(makeBundleRef("kit", "scripts/azure/container-apps/scale.sh")).toBe(
      "kit//scripts/azure/container-apps/scale.sh",
    );
  });

  test("conceptId with spaces — no encoding", () => {
    expect(makeBundleRef(undefined, "scripts/my script.sh")).toBe("scripts/my script.sh");
  });

  test("normalizes backslashes in conceptId", () => {
    expect(makeBundleRef("kit", "a\\b\\c")).toBe("kit//a/b/c");
  });

  test("rejects a bundle slug with a colon", () => {
    expect(() => makeBundleRef("npm:pkg", "a/b")).toThrow("Invalid bundle slug");
  });

  test("rejects a bundle slug with a dot", () => {
    expect(() => makeBundleRef("foo.com", "a/b")).toThrow("Invalid bundle slug");
  });

  test("rejects a bundle slug with a slash", () => {
    expect(() => makeBundleRef("owner/repo", "a/b")).toThrow("Invalid bundle slug");
  });

  test("rejects empty conceptId", () => {
    expect(() => makeBundleRef("core", "")).toThrow("Empty asset name");
  });

  test("rejects path traversal in conceptId", () => {
    expect(() => makeBundleRef("core", "../outside")).toThrow("Path traversal");
  });

  test("rejects an absolute conceptId", () => {
    expect(() => makeBundleRef("core", "/etc/passwd")).toThrow("Absolute path");
  });

  test("rejects a Windows drive path in conceptId", () => {
    expect(() => makeBundleRef("core", "C:\\foo")).toThrow("Windows drive");
  });

  test("rejects null byte in conceptId", () => {
    expect(() => makeBundleRef("core", "foo\0bar")).toThrow("Null byte");
  });

  test("rejects `#` embedded in conceptId", () => {
    expect(() => makeBundleRef("core", "a#b")).toThrow("reserved for the export fragment");
  });
});

describe("parseBundleRef", () => {
  test("short form leaves bundle undefined", () => {
    const ref = parseBundleRef("knowledge/http-caching");
    expect(ref.bundle).toBeUndefined();
    expect(ref.conceptId).toBe("knowledge/http-caching");
    expect(ref.fragment).toBeUndefined();
  });

  test("fully-qualified form", () => {
    const ref = parseBundleRef("core//knowledge/http-caching");
    expect(ref.bundle).toBe("core");
    expect(ref.conceptId).toBe("knowledge/http-caching");
  });

  test("export fragment form", () => {
    const ref = parseBundleRef("core//skills/review#usage");
    expect(ref.bundle).toBe("core");
    expect(ref.conceptId).toBe("skills/review");
    expect(ref.fragment).toBe("usage");
  });

  test("short form with fragment", () => {
    const ref = parseBundleRef("skills/review#usage");
    expect(ref.bundle).toBeUndefined();
    expect(ref.conceptId).toBe("skills/review");
    expect(ref.fragment).toBe("usage");
  });

  test("byte-wise case sensitivity is preserved", () => {
    expect(parseBundleRef("Core//Skills/Review").conceptId).toBe("Skills/Review");
    expect(parseBundleRef("Core//Skills/Review").bundle).toBe("Core");
  });

  test("normalizes backslashes in conceptId", () => {
    expect(parseBundleRef("kit//dir\\file.sh").conceptId).toBe("dir/file.sh");
  });

  test("trailing `#` yields no fragment", () => {
    const ref = parseBundleRef("core//skills/review#");
    expect(ref.fragment).toBeUndefined();
    expect(ref.conceptId).toBe("skills/review");
  });

  test("rejects empty bundle", () => {
    expect(() => parseBundleRef("//knowledge/foo")).toThrow("Empty bundle");
  });

  test("rejects a bundle slug with a colon (URL-shaped)", () => {
    expect(() => parseBundleRef("https://example.com")).toThrow("Invalid bundle slug");
  });

  test("rejects empty string", () => {
    expect(() => parseBundleRef("")).toThrow("Empty ref");
  });

  test("rejects whitespace-only string", () => {
    expect(() => parseBundleRef("   ")).toThrow("Empty ref");
  });

  test("rejects path traversal", () => {
    expect(() => parseBundleRef("core//../outside")).toThrow("Path traversal");
  });

  test("rejects an absolute conceptId", () => {
    expect(() => parseBundleRef("core///etc/passwd")).toThrow("Absolute path");
  });

  test("rejects null byte", () => {
    expect(() => parseBundleRef("core//foo\0bar")).toThrow("Null byte");
  });
});

describe("bundleRefToString round-trip", () => {
  test("bundleRefToString(parseBundleRef(s)) round-trips", () => {
    for (const s of [
      "knowledge/http-caching",
      "core//knowledge/http-caching",
      "core//skills/review#usage",
      "skills/review#usage",
      "kit//scripts/deploy.sh",
    ]) {
      expect(bundleRefToString(parseBundleRef(s))).toBe(s);
    }
  });

  test("matches makeBundleRef for the same components", () => {
    const ref: BundleRef = { bundle: "core", conceptId: "skills/review", fragment: "usage" };
    expect(bundleRefToString(ref)).toBe(makeBundleRef(ref.bundle, ref.conceptId, ref.fragment));
  });
});

describe("BUNDLE_REF_RE — body-ref recognition (prose)", () => {
  function scan(body: string): string[] {
    const re = new RegExp(BUNDLE_REF_RE.source, BUNDLE_REF_RE.flags);
    const out: string[] = [];
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
    while ((m = re.exec(body)) !== null) out.push(m[1]!);
    return out;
  }

  test("matches a fully-qualified ref mid-sentence", () => {
    expect(scan("see core//knowledge/http-caching for details")).toEqual(["core//knowledge/http-caching"]);
  });

  test("matches a ref at line start", () => {
    expect(scan("core//skills/review is relevant")).toEqual(["core//skills/review"]);
  });

  test("matches inside a markdown link bracket", () => {
    expect(scan("[core//knowledge/foo]")).toEqual(["core//knowledge/foo"]);
  });

  test("captures the export fragment", () => {
    expect(scan("core//skills/review#usage here")).toEqual(["core//skills/review#usage"]);
  });

  test("does NOT match an https URL", () => {
    expect(scan("visit https://example.com/foo/bar now")).toEqual([]);
  });

  test("does NOT match a scheme-relative URL", () => {
    expect(scan("load //cdn.example.com/lib.js please")).toEqual([]);
  });

  test("does NOT match a short-form ref (fully-qualified only in prose)", () => {
    expect(scan("see knowledge/http-caching for details")).toEqual([]);
  });

  test("matches multiple refs in one body", () => {
    expect(scan("core//a/b and kit//c/d")).toEqual(["core//a/b", "kit//c/d"]);
  });
});
