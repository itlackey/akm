import { describe, expect, test } from "bun:test";
import { makeAssetRef, parseAssetRef } from "../src/stash-ref";

// ── makeAssetRef ────────────────────────────────────────────────────────────

describe("makeAssetRef", () => {
  test("script ref", () => {
    expect(makeAssetRef("script", "deploy.sh")).toBe("script:deploy.sh");
  });

  test("skill ref", () => {
    expect(makeAssetRef("skill", "code-review")).toBe("skill:code-review");
  });

  test("nested path — slashes stay literal", () => {
    expect(makeAssetRef("script", "azure/container-apps/scale.sh")).toBe("script:azure/container-apps/scale.sh");
  });

  test("name with spaces — no encoding", () => {
    expect(makeAssetRef("script", "my script.sh")).toBe("script:my script.sh");
  });

  test("with local origin", () => {
    expect(makeAssetRef("script", "deploy.sh", "local")).toBe("local//script:deploy.sh");
  });

  test("with npm origin — colons and @ stay literal", () => {
    expect(makeAssetRef("script", "deploy.sh", "npm:@itlackey/openkit")).toBe(
      "npm:@itlackey/openkit//script:deploy.sh",
    );
  });

  test("with github shorthand origin", () => {
    expect(makeAssetRef("skill", "code-review", "itlackey/dimm-city-kit")).toBe(
      "itlackey/dimm-city-kit//skill:code-review",
    );
  });

  test("with github prefixed origin", () => {
    expect(makeAssetRef("script", "lint.sh", "github:owner/repo#v1.2")).toBe("github:owner/repo#v1.2//script:lint.sh");
  });

  test("nested name with origin", () => {
    expect(makeAssetRef("script", "db/migrate/run.sh", "npm:@corp/db-tools")).toBe(
      "npm:@corp/db-tools//script:db/migrate/run.sh",
    );
  });

  test("normalizes backslashes", () => {
    expect(makeAssetRef("script", "dir\\file.sh")).toBe("script:dir/file.sh");
  });

  test("no origin produces plain ref", () => {
    expect(makeAssetRef("agent", "architect.md")).toBe("agent:architect.md");
    expect(makeAssetRef("agent", "architect.md", undefined)).toBe("agent:architect.md");
  });

  test("rejects empty name", () => {
    expect(() => makeAssetRef("script", "")).toThrow("Empty asset name");
  });

  test("rejects null byte", () => {
    expect(() => makeAssetRef("script", "foo\0bar")).toThrow("Null byte");
  });

  test("rejects absolute path", () => {
    expect(() => makeAssetRef("script", "/etc/passwd")).toThrow("Absolute path");
  });

  test("rejects path traversal", () => {
    expect(() => makeAssetRef("script", "../outside.sh")).toThrow("Path traversal");
  });

  test("rejects Windows drive path", () => {
    expect(() => makeAssetRef("script", "C:\\foo")).toThrow("Windows drive");
  });
});

// ── parseAssetRef ───────────────────────────────────────────────────────────

describe("parseAssetRef", () => {
  test("simple script ref", () => {
    const ref = parseAssetRef("script:deploy.sh");
    expect(ref.type).toBe("script");
    expect(ref.name).toBe("deploy.sh");
    expect(ref.origin).toBeUndefined();
  });

  test("nested path stays literal", () => {
    const ref = parseAssetRef("script:azure/container-apps/scale.sh");
    expect(ref.name).toBe("azure/container-apps/scale.sh");
  });

  test("name with spaces", () => {
    const ref = parseAssetRef("script:my script.sh");
    expect(ref.name).toBe("my script.sh");
  });

  test("local origin", () => {
    const ref = parseAssetRef("local//script:deploy.sh");
    expect(ref.origin).toBe("local");
    expect(ref.type).toBe("script");
    expect(ref.name).toBe("deploy.sh");
  });

  test("npm origin with scope", () => {
    const ref = parseAssetRef("npm:@itlackey/openkit//script:deploy.sh");
    expect(ref.origin).toBe("npm:@itlackey/openkit");
    expect(ref.type).toBe("script");
    expect(ref.name).toBe("deploy.sh");
  });

  test("github shorthand origin", () => {
    const ref = parseAssetRef("itlackey/dimm-city-kit//skill:code-review");
    expect(ref.origin).toBe("itlackey/dimm-city-kit");
    expect(ref.type).toBe("skill");
    expect(ref.name).toBe("code-review");
  });

  test("github origin with tag", () => {
    const ref = parseAssetRef("github:owner/repo#v1.2//script:lint.sh");
    expect(ref.origin).toBe("github:owner/repo#v1.2");
    expect(ref.type).toBe("script");
    expect(ref.name).toBe("lint.sh");
  });

  test("nested name with origin", () => {
    const ref = parseAssetRef("npm:@corp/db-tools//script:db/migrate/run.sh");
    expect(ref.origin).toBe("npm:@corp/db-tools");
    expect(ref.name).toBe("db/migrate/run.sh");
  });

  test("path-based origin", () => {
    const ref = parseAssetRef("/mnt/shared-stash//skill:code-review");
    expect(ref.origin).toBe("/mnt/shared-stash");
    expect(ref.type).toBe("skill");
    expect(ref.name).toBe("code-review");
  });

  test("all asset types parse", () => {
    for (const type of ["skill", "command", "agent", "knowledge", "script"]) {
      const ref = parseAssetRef(`${type}:test`);
      expect(ref.type).toBe(type);
    }
  });

  test("normalizes backslashes in name", () => {
    const ref = parseAssetRef("script:dir\\file.sh");
    expect(ref.name).toBe("dir/file.sh");
  });

  test("throws for invalid type", () => {
    expect(() => parseAssetRef("widget:foo")).toThrow("Invalid asset type");
  });

  test("throws for removed tool type", () => {
    expect(() => parseAssetRef("tool:deploy.sh")).toThrow("Invalid asset type");
  });

  test("throws for missing colon", () => {
    expect(() => parseAssetRef("scriptname")).toThrow("Invalid ref");
  });

  test("throws for empty origin", () => {
    expect(() => parseAssetRef("//script:deploy.sh")).toThrow("Empty origin");
  });

  test("throws for empty name", () => {
    expect(() => parseAssetRef("script:")).toThrow("Empty asset name");
  });

  test("throws for path traversal in name", () => {
    expect(() => parseAssetRef("script:../outside.sh")).toThrow("Path traversal");
  });

  test("throws for absolute name", () => {
    expect(() => parseAssetRef("script:/etc/passwd")).toThrow("Absolute path");
  });

  test("throws for null byte in name", () => {
    expect(() => parseAssetRef("script:foo\0bar")).toThrow("Null byte");
  });

  test("throws for Windows drive in name", () => {
    expect(() => parseAssetRef("script:C:\\foo")).toThrow("Windows drive");
  });

  test("throws for empty string", () => {
    expect(() => parseAssetRef("")).toThrow("Empty ref");
  });

  test("throws for whitespace-only string", () => {
    expect(() => parseAssetRef("   ")).toThrow("Empty ref");
  });
});

// ── Round-trips ─────────────────────────────────────────────────────────────

describe("round-trip", () => {
  test("script round-trips", () => {
    const str = makeAssetRef("script", "deploy.sh");
    expect(str).toBe("script:deploy.sh");
    const parsed = parseAssetRef(str);
    expect(parsed).toEqual({ type: "script", name: "deploy.sh", origin: undefined });
  });

  test("with npm origin", () => {
    const str = makeAssetRef("script", "deploy.sh", "npm:@scope/pkg");
    const parsed = parseAssetRef(str);
    expect(parsed).toEqual({ type: "script", name: "deploy.sh", origin: "npm:@scope/pkg" });
  });

  test("nested path with origin", () => {
    const str = makeAssetRef("script", "db/migrate/run.sh", "npm:@corp/tools");
    const parsed = parseAssetRef(str);
    expect(parsed).toEqual({ type: "script", name: "db/migrate/run.sh", origin: "npm:@corp/tools" });
  });

  test("local origin", () => {
    const str = makeAssetRef("skill", "review", "local");
    const parsed = parseAssetRef(str);
    expect(parsed).toEqual({ type: "skill", name: "review", origin: "local" });
  });

  test("github origin with tag", () => {
    const str = makeAssetRef("script", "lint.sh", "github:owner/repo#v2.0");
    const parsed = parseAssetRef(str);
    expect(parsed).toEqual({ type: "script", name: "lint.sh", origin: "github:owner/repo#v2.0" });
  });

  test("name with spaces", () => {
    const str = makeAssetRef("command", "my command.md");
    const parsed = parseAssetRef(str);
    expect(parsed).toEqual({ type: "command", name: "my command.md", origin: undefined });
  });

  test("every asset type round-trips", () => {
    for (const type of ["skill", "command", "agent", "knowledge", "script"] as const) {
      const str = makeAssetRef(type, "test-asset", "owner/repo");
      const parsed = parseAssetRef(str);
      expect(parsed.type).toBe(type);
      expect(parsed.name).toBe("test-asset");
      expect(parsed.origin).toBe("owner/repo");
    }
  });
});
