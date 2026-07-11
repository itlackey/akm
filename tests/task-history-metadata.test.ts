// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { decodeTaskHistoryMetadata } from "../src/storage/repositories/task-history-repository";

describe("decodeTaskHistoryMetadata", () => {
  test("keeps v1 profile identity separate as legacyProfile", () => {
    expect(decodeTaskHistoryMetadata('{"durationMs":12,"profile":"old"}')).toEqual({
      metadataVersion: 1,
      durationMs: 12,
      legacyProfile: "old",
    });
  });

  test("decodes exact v2 engine metadata", () => {
    expect(
      decodeTaskHistoryMetadata({
        metadataVersion: 2,
        durationMs: 12,
        detail: { exitCode: 0 },
        engine: "local",
      }),
    ).toEqual({ metadataVersion: 2, durationMs: 12, detail: { exitCode: 0 }, engine: "local" });
  });

  test("rejects unknown versions, cross-version aliases, extras, and missing v2 fields", () => {
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 3 })).toThrow(/unsupported metadataVersion/);
    expect(() =>
      decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null, profile: "old" }),
    ).toThrow(/unknown v2 fields/);
    expect(() => decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1 })).toThrow(/detail is required/);
    expect(() => decodeTaskHistoryMetadata({ durationMs: 1, extra: true })).toThrow(/unknown v1 fields/);
  });
});
