// Proof for candidate: migrateConfigSourcesToBundles never re-keys
// `defaultWriteTarget` to the derived bundle id, so a 0.8 config whose
// defaultWriteTarget names a non-slug source hard-blocks `migrate apply`.

import { describe, expect, test } from "bun:test";
import { parseAndValidateConfigText } from "../../src/core/config/config";
import { validateConfigShape } from "../../src/core/config/config-schema";
import { migrateConfigSourcesToBundles } from "../../src/migrate/legacy/config-source-migration";

/**
 * Realistic pre-cutover (0.8.x) config: a writable primary filesystem source
 * whose `name` carries a `.` ("my.docs"), and defaultWriteTarget pointing at
 * that source name. configVersion is already "0.9.0" (matches how prepared
 * migration configs are seeded — see tests/migrate/legacy/config-source-migration.test.ts).
 */
function oldShapeConfigWithDottedWriteTarget(): Record<string, unknown> {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    defaultWriteTarget: "my.docs",
    sources: [{ type: "filesystem", path: "/home/u/docs", name: "my.docs", writable: true, primary: true }],
  };
}

describe("defaultWriteTarget is not re-keyed by the config-shape migration", () => {
  test("migrator derives bundle key `docs` but leaves defaultWriteTarget `my.docs`", () => {
    const migrated = migrateConfigSourcesToBundles(oldShapeConfigWithDottedWriteTarget()) as {
      bundles: Record<string, unknown>;
      defaultBundle?: string;
      defaultWriteTarget?: string;
    };

    // The non-slug source name slugs from the path -> key "docs".
    expect(Object.keys(migrated.bundles)).toEqual(["docs"]);
    expect(migrated.defaultBundle).toBe("docs");
    // defaultWriteTarget is carried verbatim -> now points at a key that does NOT exist.
    expect(migrated.defaultWriteTarget).toBe("my.docs");
    expect(Object.keys(migrated.bundles)).not.toContain("my.docs");
  });

  test("the migrated config FAILS schema validation at path defaultWriteTarget", () => {
    const migrated = migrateConfigSourcesToBundles(oldShapeConfigWithDottedWriteTarget());
    const result = validateConfigShape(migrated);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    const dwtIssue = result.errors.find((e) => e.path === "defaultWriteTarget");
    expect(dwtIssue).toBeDefined();
    expect(dwtIssue?.message).toContain("does not match any configured bundle");
  });

  test("parseMigrationTargetConfig equivalent THROWS -> loadTargetConfig marks target corrupt -> `migrate apply` blocked", () => {
    // Exactly the two calls parseMigrationTargetConfig makes (config-migrate.ts L1919-1924).
    const migrated = migrateConfigSourcesToBundles(oldShapeConfigWithDottedWriteTarget());
    expect(() => parseAndValidateConfigText(JSON.stringify(migrated))).toThrow(/defaultWriteTarget/);
  });

  test("CONTRAST: a slug-legal source name migrates and validates fine (proves this bites only non-slug names)", () => {
    const ok = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      defaultWriteTarget: "mydocs",
      sources: [{ type: "filesystem", path: "/home/u/docs", name: "mydocs", writable: true, primary: true }],
    };
    const migrated = migrateConfigSourcesToBundles(ok) as { bundles: Record<string, unknown> };
    expect(Object.keys(migrated.bundles)).toEqual(["mydocs"]);
    expect(validateConfigShape(migrated).ok).toBe(true);
    expect(() => parseAndValidateConfigText(JSON.stringify(migrated))).not.toThrow();
  });
});
