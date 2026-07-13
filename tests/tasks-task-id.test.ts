import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import { MAX_PORTABLE_TASK_ID_LENGTH, normaliseTaskId, validateTaskId } from "../src/tasks/task-id";

function invalidTaskId(id: string): UsageError {
  try {
    validateTaskId(id);
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error(`Expected task id "${id}" to be rejected`);
}

describe("validateTaskId", () => {
  test.each([
    "daily",
    "Daily_2",
    "release.notes-v1",
    "console",
    "com10",
    "lpt0",
    "com1-report",
    "auxiliary",
  ])("accepts portable canonical id %s", (id) => {
    expect(validateTaskId(id)).toBe(id);
  });

  test.each([
    "daily.yml",
    "daily.YML",
    "daily.yaml",
    "daily.YaMl",
  ])("rejects canonical id with task-file suffix %s", (id) => {
    const err = invalidTaskId(id);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toContain("bare task id");
    expect(err.message).toContain(".yml or .yaml");
  });

  test.each([
    "CON",
    "con",
    "CoN.log",
    "PRN.backup",
    "aux.txt",
    "NUL.anything",
    "COM1",
    "com9.log",
    "LPT1",
    "lPt9.backup",
  ])("rejects Windows reserved device alias %s", (id) => {
    const err = invalidTaskId(id);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toContain("reserved Windows device name");
    expect(err.message).toContain("Choose a different task id");
  });

  test("enforces the portable scheduler-derived length bound", () => {
    expect(MAX_PORTABLE_TASK_ID_LENGTH).toBe(228);
    const boundaryId = "a".repeat(MAX_PORTABLE_TASK_ID_LENGTH);
    expect(validateTaskId(boundaryId)).toHaveLength(MAX_PORTABLE_TASK_ID_LENGTH);
    expect(`akm-task-${boundaryId}-${"0".repeat(13)}.xml`).toHaveLength(255);

    const overBoundaryId = "a".repeat(MAX_PORTABLE_TASK_ID_LENGTH + 1);
    expect(`akm-task-${overBoundaryId}-${"0".repeat(13)}.xml`).toHaveLength(256);
    const err = invalidTaskId(overBoundaryId);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toContain(`at most ${MAX_PORTABLE_TASK_ID_LENGTH} characters`);
    expect(err.message).toContain("all supported schedulers");
  });
});

describe("normaliseTaskId", () => {
  test("keeps accepting a legacy task-file suffix at the CLI boundary", () => {
    expect(normaliseTaskId(" daily.yml ")).toBe("daily");
  });

  test("still rejects a reserved device name after removing a legacy suffix", () => {
    expect(() => normaliseTaskId("CON.yml")).toThrow("reserved Windows device name");
  });
});
