import { expect } from "bun:test";
import { localDateStamp } from "../../src/core/common";

/**
 * The asset writer stamps today's `updated` on every create and update, a revert included. A restored or rewritten
 * asset therefore equals what it should hold except for that one line, which is today's date.
 */
export function expectSameExceptUpdated(actual: string, expected: string): void {
  const withoutUpdated = (text: string) => text.replace(/^updated: .*\r?\n/m, "");
  expect(withoutUpdated(actual)).toBe(withoutUpdated(expected));
  expect(actual).toMatch(new RegExp(`^updated: ${localDateStamp(new Date())}\\r?$`, "m"));
}
