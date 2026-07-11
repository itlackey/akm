import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

test("task schema and package contents pin the strict v2 public artifact", () => {
  const root = path.resolve(import.meta.dir, "..");
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "akm-task.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  expect(schema.properties.version.const).toBe(2);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toContain("version");
  expect(schema.properties).not.toHaveProperty("profile");
  expect(schema.oneOf).toHaveLength(3);
  expect(pkg.files).toContain("schemas");
  expect(pkg.files).toContain("docs/migration/v0.8-to-v0.9.md");
});
