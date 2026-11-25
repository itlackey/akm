// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `experimental.web` in the config schema, and `config.webSettings()` as Desktop's server reads it. */

import { afterEach, describe, expect, test } from "bun:test";
import { resetConfigCache } from "../../../src/core/config/config";
import { AkmConfigSchema } from "../../../src/core/config/config-schema";
import { config } from "../../../src/workspace";
import { writeSandboxConfig } from "../../_helpers/sandbox";
import { ctx, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();
afterEach(() => {
  resetConfigCache();
  delete process.env.WEB_TEST_SECRET;
});

const BASE = { configVersion: "0.9.0" as const };
const parse = (web: unknown) => AkmConfigSchema.safeParse({ ...BASE, experimental: { web } }).success;
const configure = (web: unknown) => {
  writeSandboxConfig({ experimental: { web } });
  resetConfigCache();
};

describe("experimental.web schema", () => {
  test("accepts every key, all optional", () => {
    expect(parse({})).toBe(true);
    expect(
      parse({
        host: "0.0.0.0",
        port: 0,
        origin: "https://akm.example.com:8443",
        secret: "${WEB_TEST_SECRET}",
        allowedHosts: ["akm.internal"],
        frameParents: ["https://app.example.com"],
      }),
    ).toBe(true);
    expect(parse({ secret: "$WEB_TEST_SECRET" })).toBe(true);
    expect(parse({ secret: "${secrets/web}" })).toBe(true);
    expect(parse({ origin: "http://127.0.0.1:4096/" })).toBe(true);
    expect(parse({ allowedHosts: ["akm.internal", "akm.internal:8080", "10.0.0.5", "[::1]", "[::1]:3000"] })).toBe(
      true,
    );
  });

  test.each([
    [{ port: 65536 }],
    [{ port: -1 }],
    [{ port: 1.5 }],
    [{ host: 5 }],
    [{ secret: "literal-secret-value" }],
    [{ origin: "https://example.com/path" }],
    [{ origin: "https://example.com?x=1" }],
    [{ origin: "https://example.com#frag" }],
    [{ origin: "ftp://example.com" }],
    [{ origin: "example.com" }],
    [{ allowedHosts: "akm.internal" }],
    [{ frameParents: ["https://app.example.com/x"] }],
    [{ frameParents: ["app.example.com"] }],
    [{ frameParents: ["https://*.example.com"] }],
    [{ allowedHosts: ["http://akm.internal"] }],
    [{ allowedHosts: ["akm.internal/path"] }],
    [{ allowedHosts: ["akm.internal:99999"] }],
    [{ allowedHosts: ["akm.internal:"] }],
    [{ allowedHosts: ["*.internal"] }],
    [{ allowedHosts: [""] }],
  ])("refuses %j", (web) => {
    expect(parse(web)).toBe(false);
  });
});

describe("config.webSettings", () => {
  test("is empty lists and no secret when nothing is configured", () => {
    expect(config.webSettings()).toEqual({ allowedHosts: [], frameParents: [] });
  });

  test("returns the configured values and the resolved secret", () => {
    process.env.WEB_TEST_SECRET = "s".repeat(40);
    configure({
      host: "0.0.0.0",
      port: 4096,
      origin: "https://akm.example.com",
      secret: "$WEB_TEST_SECRET",
      allowedHosts: ["akm.internal"],
      frameParents: ["https://app.example.com"],
    });
    expect(config.webSettings()).toEqual({
      host: "0.0.0.0",
      port: 4096,
      origin: "https://akm.example.com",
      allowedHosts: ["akm.internal"],
      frameParents: ["https://app.example.com"],
      secret: "s".repeat(40),
    });
  });

  test("names the reference, not a value, when it cannot be read", () => {
    configure({ secret: "$WEB_TEST_SECRET" });
    expect(() => config.webSettings()).toThrow("$WEB_TEST_SECRET");
    configure({ secret: "${secrets/missing}" });
    expect(() => config.webSettings()).toThrow("${secrets/missing}");
  });

  test("does not read the reference when asked not to", () => {
    configure({ secret: "$WEB_TEST_SECRET", port: 4096 });
    expect(config.webSettings({ resolveSecret: false })).toEqual({ port: 4096, allowedHosts: [], frameParents: [] });
  });

  test("get() shows the reference and never resolves it", () => {
    process.env.WEB_TEST_SECRET = "resolved-value-that-must-not-appear";
    configure({ secret: "$WEB_TEST_SECRET" });
    const shown = JSON.stringify(config.get());
    expect(shown).toContain("$WEB_TEST_SECRET");
    expect(shown).not.toContain("resolved-value-that-must-not-appear");
    expect(ctx.storage.configDir).toBeTruthy();
  });
});
