/**
 * Tests for the output shape registry and text formatter registry patterns.
 *
 * Phase C of issue #494: verify that both registries accept mock handlers,
 * dispatch correctly, and clean up after themselves.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { deregisterOutputShape, registerOutputShape, shapeForCommand } from "../src/output/shapes";
import { deregisterTextFormatter, formatPlain, registerTextFormatter } from "../src/output/text";

// ── Output shape registry ─────────────────────────────────────────────────────

describe("registerOutputShape", () => {
  afterEach(() => {
    deregisterOutputShape("mock-command");
  });

  test("registered handler is called by shapeForCommand", () => {
    let called = false;
    registerOutputShape("mock-command", (result) => {
      called = true;
      return result;
    });
    shapeForCommand("mock-command", { foo: "bar" }, "brief");
    expect(called).toBe(true);
  });

  test("handler receives result, detail, and shape", () => {
    const calls: Array<[unknown, string, string]> = [];
    registerOutputShape("mock-command", (result, detail, shape) => {
      calls.push([result, detail, shape]);
      return result;
    });
    const input = { x: 1 };
    shapeForCommand("mock-command", input, "normal", "agent");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(input);
    expect(calls[0][1]).toBe("normal");
    expect(calls[0][2]).toBe("agent");
  });

  test("handler return value is used by shapeForCommand", () => {
    registerOutputShape("mock-command", () => ({ shaped: true }));
    const out = shapeForCommand("mock-command", {}, "brief") as Record<string, unknown>;
    expect(out.shaped).toBe(true);
  });

  test("deregistered handler causes shapeForCommand to throw", () => {
    registerOutputShape("mock-command", (r) => r);
    deregisterOutputShape("mock-command");
    expect(() => shapeForCommand("mock-command", {}, "brief")).toThrow(
      "output shape not registered for command: mock-command",
    );
  });

  test("unknown command still throws (exhaustive registry invariant)", () => {
    expect(() => shapeForCommand("not-a-command", {}, "brief")).toThrow(
      "output shape not registered for command: not-a-command",
    );
  });
});

// ── Text formatter registry ───────────────────────────────────────────────────

describe("registerTextFormatter", () => {
  afterEach(() => {
    deregisterTextFormatter("mock-text-command");
  });

  test("registered handler is called by formatPlain", () => {
    let called = false;
    registerTextFormatter("mock-text-command", () => {
      called = true;
      return "ok";
    });
    formatPlain("mock-text-command", {}, "brief");
    expect(called).toBe(true);
  });

  test("handler receives result and detail", () => {
    const calls: Array<[Record<string, unknown>, string]> = [];
    registerTextFormatter("mock-text-command", (r, detail) => {
      calls.push([r, detail]);
      return "ok";
    });
    const input = { v: 42 };
    formatPlain("mock-text-command", input, "full");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(input);
    expect(calls[0][1]).toBe("full");
  });

  test("handler return value is used by formatPlain", () => {
    registerTextFormatter("mock-text-command", () => "hello from handler");
    expect(formatPlain("mock-text-command", {}, "brief")).toBe("hello from handler");
  });

  test("handler returning null propagates as null (YAML fallback)", () => {
    registerTextFormatter("mock-text-command", () => null);
    expect(formatPlain("mock-text-command", {}, "brief")).toBeNull();
  });

  test("deregistered handler makes formatPlain return null (YAML fallback)", () => {
    registerTextFormatter("mock-text-command", () => "x");
    deregisterTextFormatter("mock-text-command");
    expect(formatPlain("mock-text-command", {}, "brief")).toBeNull();
  });

  test("unknown command returns null (YAML fallback, not a throw)", () => {
    expect(formatPlain("not-a-command", {}, "brief")).toBeNull();
  });
});
