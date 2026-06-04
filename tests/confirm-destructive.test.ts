import { describe, expect, test } from "bun:test";
import { confirmDestructive } from "../src/cli/confirm";
import { UsageError } from "../src/core/errors";

// ── Helper: override stdin.isTTY for test ───────────────────────────────────

function withTTY(isTTY: boolean, fn: () => Promise<void>) {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("confirmDestructive", () => {
  test("returns true immediately when --yes is passed (skips prompt)", async () => {
    const result = await confirmDestructive("Delete everything?", { yes: true });
    expect(result).toBe(true);
  });

  test("returns true immediately when --yes is passed even in non-TTY context", async () => {
    await withTTY(false, async () => {
      const result = await confirmDestructive("Remove source?", { yes: true });
      expect(result).toBe(true);
    });
  });

  test("throws UsageError(NON_INTERACTIVE_REQUIRES_YES) in non-TTY context without --yes", async () => {
    await withTTY(false, async () => {
      await expect(confirmDestructive("Reject proposal abc?", { yes: false })).rejects.toMatchObject({
        code: "NON_INTERACTIVE_REQUIRES_YES",
      });
    });
  });

  test("thrown error message includes the action description", async () => {
    await withTTY(false, async () => {
      try {
        await confirmDestructive("Remove source my-stash?", { yes: false });
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain("Remove source my-stash?");
        expect((err as UsageError).message).toContain("--yes");
      }
    });
  });
});
