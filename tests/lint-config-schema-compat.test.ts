// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `findSchemaRegressions` (`scripts/lint-config-schema-compat.ts`) is pure —
 * no filesystem, no git — so it is exercised directly here with synthetic
 * JSON Schema documents rather than the repo's real `schemas/akm-config.json`.
 * `resolvePreviousStableTag` (the git/tag wiring's one non-trivial piece of
 * logic) is also pure and covered separately below.
 */

import { describe, expect, test } from "bun:test";
import {
  findSchemaRegressions,
  type JsonSchemaNode,
  resolvePreviousStableTag,
} from "../scripts/lint-config-schema-compat";

describe("findSchemaRegressions — removed property", () => {
  const previous: JsonSchemaNode = {
    type: "object",
    properties: {
      foo: { type: "string" },
      bar: { type: "object", properties: { x: { type: "string" } } },
    },
  };
  const current: JsonSchemaNode = {
    type: "object",
    properties: {
      bar: { type: "object", properties: { x: { type: "string" } } },
    },
  };

  test("an unregistered removal is reported", () => {
    const regressions = findSchemaRegressions(previous, current, { retiredKeys: [], strictenedObjects: [] });
    expect(regressions).toEqual([{ kind: "removed-property", path: "foo" }]);
  });

  test("a registered removal is not reported", () => {
    const regressions = findSchemaRegressions(previous, current, {
      retiredKeys: [{ path: "foo" }],
      strictenedObjects: [],
    });
    expect(regressions).toEqual([]);
  });
});

describe("findSchemaRegressions — strictened object", () => {
  const previous: JsonSchemaNode = {
    type: "object",
    properties: {
      bar: { type: "object", properties: { x: { type: "string" } }, additionalProperties: true },
    },
  };
  const current: JsonSchemaNode = {
    type: "object",
    properties: {
      bar: { type: "object", properties: { x: { type: "string" } }, additionalProperties: false },
    },
  };

  test("an unregistered strictness tightening is reported", () => {
    const regressions = findSchemaRegressions(previous, current, { retiredKeys: [], strictenedObjects: [] });
    expect(regressions).toEqual([{ kind: "strictened-object", path: "bar" }]);
  });

  test("a registered strictness tightening is not reported", () => {
    const regressions = findSchemaRegressions(previous, current, {
      retiredKeys: [],
      strictenedObjects: [{ path: "bar" }],
    });
    expect(regressions).toEqual([]);
  });

  test("a brand-new strict object (no prior shape to regress from) is not reported", () => {
    const previousWithoutBaz: JsonSchemaNode = { type: "object", properties: {} };
    const currentWithNewBaz: JsonSchemaNode = {
      type: "object",
      properties: {
        baz: { type: "object", properties: { y: { type: "string" } }, additionalProperties: false },
      },
    };
    const regressions = findSchemaRegressions(previousWithoutBaz, currentWithNewBaz, {
      retiredKeys: [],
      strictenedObjects: [],
    });
    expect(regressions).toEqual([]);
  });
});

describe("findSchemaRegressions — $defs refactor", () => {
  test("a type moved into $defs and referenced by $ref is not a false positive", () => {
    const previous: JsonSchemaNode = {
      type: "object",
      properties: {
        foo: {
          type: "object",
          properties: {
            bar: {
              type: "object",
              properties: { x: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      },
    };
    const current: JsonSchemaNode = {
      type: "object",
      properties: {
        foo: {
          type: "object",
          properties: { bar: { $ref: "#/$defs/Bar" } },
        },
      },
      $defs: {
        Bar: { type: "object", properties: { x: { type: "string" } }, additionalProperties: false },
      },
    };

    const regressions = findSchemaRegressions(previous, current, { retiredKeys: [], strictenedObjects: [] });
    expect(regressions).toEqual([]);
  });
});

describe("resolvePreviousStableTag", () => {
  test("picks the highest stable tag below the current version, ignoring prereleases and higher tags", () => {
    const tags = ["v0.9.14", "v0.9.15", "v0.9.15-beta.1", "v0.9.16", "v0.9.17", "v0.9.17-alpha.1"];
    expect(resolvePreviousStableTag("0.9.17-alpha.3", tags)).toBe("v0.9.16");
  });

  test("throws (never resolves nothing) when no stable tag is below the current version", () => {
    expect(() => resolvePreviousStableTag("0.9.17-alpha.3", ["v0.9.17-alpha.1", "v0.9.18"])).toThrow(
      /no reachable stable v\* tag/,
    );
  });
});
