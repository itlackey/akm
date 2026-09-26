// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isConsolidationEligibleMemoryName, isHotCapturedMemory } from "../../../src/commands/improve/consolidate";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eligibility-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

describe("isHotCapturedMemory — lenient hot check (fail-safe to not-hot)", () => {
  it("is true for captureMode: hot", () => {
    const p = write("hot2.md", "---\ncaptureMode: hot\n---\nbody\n");
    expect(isHotCapturedMemory(p)).toBe(true);
  });

  it("is false for a missing file (lenient — unlike the strict guard)", () => {
    expect(isHotCapturedMemory(path.join(tmp, "missing2.md"))).toBe(false);
  });

  it("is false for a non-hot memory", () => {
    const p = write("cold.md", "---\ntype: memory\n---\nbody\n");
    expect(isHotCapturedMemory(p)).toBe(false);
  });
});

describe("isConsolidationEligibleMemoryName", () => {
  it("excludes .derived memories", () => {
    expect(isConsolidationEligibleMemoryName("foo.derived")).toBe(false);
  });
  it("includes normal memories", () => {
    expect(isConsolidationEligibleMemoryName("foo")).toBe(true);
  });
});
