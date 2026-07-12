// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  ENV_PASSTHROUGH_REDACTION_ALLOWLIST,
  isEnvPassthroughValueSafeToExpose,
  redactSensitiveText,
  redactSensitiveValue,
} from "../src/core/redaction";

describe("redactSensitiveText", () => {
  test("redacts exact values longest-first without treating them as patterns", () => {
    expect(
      redactSensitiveText("long-secret and secret and cost=$&-sentinel", ["secret", "long-secret", "$&-sentinel"]),
    ).toBe("[REDACTED] and [REDACTED] and cost=[REDACTED]");
  });

  test("redacts every non-empty exact value regardless of length", () => {
    expect(redactSensitiveText("a=abc ab=a", ["", "a", "ab", "abc"])).toBe(
      "[REDACTED]=[REDACTED] [REDACTED]=[REDACTED]",
    );
  });

  test("redacts structured string keys and values recursively", () => {
    const redacted: unknown = redactSensitiveValue({ secret: [{ echoed: "secret" }] }, ["secret"]);
    expect(redacted).toEqual({
      "[REDACTED]": [{ echoed: "[REDACTED]" }],
    });
  });
});

describe("environment passthrough redaction policy", () => {
  test("keeps ordinary values for every explicitly classified allowlisted name", () => {
    for (const name of ENV_PASSTHROUGH_REDACTION_ALLOWLIST) {
      expect(isEnvPassthroughValueSafeToExpose(name, "ordinary-runtime-value"), name).toBe(true);
    }
  });

  test("rejects URL userinfo and signed query credentials under every allowlisted name", () => {
    for (const name of ENV_PASSTHROUGH_REDACTION_ALLOWLIST) {
      expect(isEnvPassthroughValueSafeToExpose(name, "https://user:password@example.test/v1"), name).toBe(false);
      expect(
        isEnvPassthroughValueSafeToExpose(
          name,
          "https://example.test/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=secret",
        ),
        name,
      ).toBe(false);
      for (const url of [
        "https://example.test/oauth/callback?client_secret=secret",
        "https://example.test/oauth/callback?session_token=secret",
        "https://example.test/oauth/callback?code=authorization-code&state=public-state",
        "https://example.test/oauth/callback#access_token=secret&token_type=bearer",
      ]) {
        expect(isEnvPassthroughValueSafeToExpose(name, url), `${name}: ${url}`).toBe(false);
      }
    }
  });

  test("allows unsigned endpoint queries but rejects non-allowlisted names", () => {
    expect(isEnvPassthroughValueSafeToExpose("LLM_BASE_URL", "https://example.test/v1?api-version=2026-01-01")).toBe(
      true,
    );
    expect(
      isEnvPassthroughValueSafeToExpose(
        "LLM_BASE_URL",
        "https://example.test/public/docs?api-version=2026-01-01&language=en#authentication",
      ),
    ).toBe(true);
    expect(isEnvPassthroughValueSafeToExpose("CUSTOM_VALUE", "ordinary-runtime-value")).toBe(false);
  });
});
