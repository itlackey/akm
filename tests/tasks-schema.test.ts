import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EXTRA_PARAMS_CREDENTIAL_KEYS, EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS } from "../src/core/extra-params";

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
  const extraParams = schema.definitions.extraParams;
  expect(extraParams["x-akm-protectedTopLevelNormalizedKeys"]).toEqual(EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS);
  expect(extraParams["x-akm-recursivelyForbiddenNormalizedKeys"]).toEqual(EXTRA_PARAMS_CREDENTIAL_KEYS);
  expect(schema.definitions.extraParamValue.anyOf[1].items.$ref).toBe("#/definitions/extraParamValue");
});
