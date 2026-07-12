// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  collectSensitiveValues,
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
    const oauthCredentialKeys = [
      "access_token",
      "actor_token",
      "assertion",
      "authorization_code",
      "auth_req_id",
      "client_assertion",
      "client_secret",
      "code_verifier",
      "device_code",
      "id_token",
      "id_token_hint",
      "initial_access_token",
      "login_hint_token",
      "logout_hint",
      "logout_token",
      "nonce",
      "oauth_token",
      "oauth_verifier",
      "refresh_token",
      "registration_access_token",
      "request_uri",
      "response",
      "software_statement",
      "state",
      "subject_token",
      "user_code",
      "verifier",
    ];
    for (const name of ENV_PASSTHROUGH_REDACTION_ALLOWLIST) {
      expect(isEnvPassthroughValueSafeToExpose(name, "https://user:password@example.test/v1"), name).toBe(false);
      expect(
        isEnvPassthroughValueSafeToExpose(
          name,
          "https://example.test/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=secret",
        ),
        name,
      ).toBe(false);
      for (const key of oauthCredentialKeys) {
        for (const url of [
          `https://example.test/oauth/callback?${key}=secret&state=public-state`,
          `https://example.test/oauth/callback#${key}=secret&token_type=bearer`,
          `https://example.test/#/nested/oauth/callback?mode=finish&${key}=secret`,
        ]) {
          expect(isEnvPassthroughValueSafeToExpose(name, url), `${name}: ${url}`).toBe(false);
        }
      }
    }
  });

  test("allows unsigned endpoint queries but rejects non-allowlisted names", () => {
    for (const url of [
      "https://example.test/v1?api-version=2026-01-01",
      "https://example.test/public/docs?api-version=2026-01-01&language=en#authentication",
      "https://example.test/oauth/authorize?client_id=public-client&redirect_uri=https%3A%2F%2Fapp.test%2Fcallback&response_type=code&scope=openid&code_challenge=public-challenge&code_challenge_method=S256",
    ]) {
      expect(isEnvPassthroughValueSafeToExpose("LLM_BASE_URL", url), url).toBe(true);
    }
    expect(isEnvPassthroughValueSafeToExpose("CUSTOM_VALUE", "ordinary-runtime-value")).toBe(false);
  });
});

describe("collectSensitiveValues", () => {
  test("collects full credential URLs and decoded query and SPA-fragment values", () => {
    const queryUrl =
      "https://example.test/callback?registration_access_token=registration%2Btoken&request_uri=urn%3Aexample%3Arequest%3A123";
    const fragmentUrl = "https://example.test/#/oauth/callback?state=state%20token&response=header.payload.signature";

    expect(collectSensitiveValues([queryUrl, fragmentUrl])).toEqual(
      expect.arrayContaining([
        queryUrl,
        fragmentUrl,
        "registration%2Btoken",
        "registration+token",
        "urn%3Aexample%3Arequest%3A123",
        "urn:example:request:123",
        "state%20token",
        "state token",
        "header.payload.signature",
      ]),
    );
  });

  test("redacts a percent-encoded credential echoed without its containing URL", () => {
    const url = "https://issuer.test/callback#access_token=oidc%2Ftoken%2Bsentinel";
    expect(redactSensitiveText("provider echoed oidc%2Ftoken%2Bsentinel", collectSensitiveValues([url]))).toBe(
      "provider echoed [REDACTED]",
    );
  });
});
