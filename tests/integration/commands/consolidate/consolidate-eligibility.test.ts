// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  consolidateGuardStatus,
  isConsolidationEligibleMemoryName,
  isHotCapturedMemory,
} from "../../../../src/commands/improve/consolidate/eligibility";

// Characterization pin for the destructive-op guard (D3 step 4). consolidateGuardStatus
// was a private helper with no direct test; extracting it to a module boundary
// warrants pinning all four verdicts so future drift is caught.

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

describe("consolidateGuardStatus — destructive-op safety verdicts", () => {
  it("returns 'missing' when the file does not exist", () => {
    expect(consolidateGuardStatus(path.join(tmp, "does-not-exist.md"))).toBe("missing");
  });

  it("returns 'hot' for a user-explicit captureMode: hot memory", () => {
    const p = write("hot.md", "---\ncaptureMode: hot\ntype: memory\n---\nbody\n");
    expect(consolidateGuardStatus(p)).toBe("hot");
  });

  it("returns 'safe' for a normal memory with frontmatter", () => {
    const p = write("safe.md", "---\ntype: memory\ndescription: x\n---\nbody\n");
    expect(consolidateGuardStatus(p)).toBe("safe");
  });

  it("returns 'unparseable' for a file with no frontmatter keys", () => {
    const p = write("nofm.md", "just body, no frontmatter\n");
    expect(consolidateGuardStatus(p)).toBe("unparseable");
  });

  it("returns 'unparseable' for an empty frontmatter block", () => {
    const p = write("emptyfm.md", "---\n---\nbody\n");
    expect(consolidateGuardStatus(p)).toBe("unparseable");
  });
});

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
