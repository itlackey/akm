// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  collectSensitiveValues,
  ENV_PASSTHROUGH_REDACTION_ALLOWLIST,
  isEnvPassthroughValueSafeToExpose,
  redactCredentialPatterns,
  redactSensitiveText,
  redactSensitiveValue,
} from "../src/core/redaction";

describe("redactCredentialPatterns", () => {
  test("redacts a Discord webhook URL, keeping the webhook id", () => {
    const text = "uncaught fetch error: https://discord.com/api/webhooks/123456789012345678/abcDEF-123_token";
    expect(redactCredentialPatterns(text)).toBe(
      "uncaught fetch error: https://discord.com/api/webhooks/123456789012345678/[REDACTED]",
    );
  });

  test("redacts a Slack incoming-webhook URL, keeping the team/channel ids", () => {
    // Deliberately non-realistic segments: GitHub push protection rejects
    // fixtures shaped like live Slack webhooks (T…/B…/24-char token).
    const text = "posting to https://hooks.slack.com/services/Tfake/Bfake/faketoken now";
    expect(redactCredentialPatterns(text)).toBe(
      "posting to https://hooks.slack.com/services/Tfake/Bfake/[REDACTED] now",
    );
  });

  test("still catches Bearer tokens and sk- style API keys", () => {
    expect(redactCredentialPatterns("Authorization: Bearer abc123XYZ.token-value")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactCredentialPatterns('{"error":"bad key sk-proj-Abcdef1234567890ZZZ"}')).toBe(
      '{"error":"bad key [REDACTED]"}',
    );
  });

  test("leaves ordinary URLs and long text untouched (no truncation)", () => {
    const ordinary = "See https://example.com/api/webhooks/123/abc for docs, plus more context after that.";
    expect(redactCredentialPatterns(ordinary)).toBe(ordinary);
    const long = "x".repeat(500);
    expect(redactCredentialPatterns(long)).toBe(long);
  });

  test("returns empty for empty input", () => {
    expect(redactCredentialPatterns("")).toBe("");
  });
});

// akm-usage-redaction (#privacy): the Claude Code hook curates every user
// prompt, so a credential pasted into a query reaches akm's own query
// persistence path before any provider ever sees it. These patterns are the
// ones a scan of mined queries actually found (PASSWORD=…, TOKEN=…, SECRET=…)
// plus the other credential shapes listed in that scan's remediation plan.
describe("redactCredentialPatterns — named KEY=value / KEY: value", () => {
  test.each([
    ["PASSWORD", "PASSWORD=hunter2", "PASSWORD=[REDACTED]"],
    ["passwd", "passwd=hunter2", "passwd=[REDACTED]"],
    ["TOKEN", "TOKEN=abc123", "TOKEN=[REDACTED]"],
    ["token (colon form)", "token: abc123", "token: [REDACTED]"],
    ["SECRET", "SECRET=xyz789", "SECRET=[REDACTED]"],
    ["snake_case api_key", "api_key: sk-abcdefghijklmnop", "api_key: [REDACTED]"],
    ["camelCase apiKey", "apiKey=abcdef123456", "apiKey=[REDACTED]"],
    ["kebab-case API-KEY", "API-KEY=abcdef123456", "API-KEY=[REDACTED]"],
    ["glued apikey", "apikey=abcdef123456", "apikey=[REDACTED]"],
    ["snake_case private_key", "private_key=abcdef123456", "private_key=[REDACTED]"],
    ["camelCase privateKey", "privateKey: abcdef123456", "privateKey: [REDACTED]"],
    ["AUTH", "AUTH=abcdef123456", "AUTH=[REDACTED]"],
    ["CREDENTIALS (plural)", "CREDENTIALS=abcdef123456", "CREDENTIALS=[REDACTED]"],
    ["credential (singular)", "credential=abcdef123456", "credential=[REDACTED]"],
    ["quoted value", 'SECRET="my secret value"', "SECRET=[REDACTED]"],
  ])("redacts %s", (_label, input, expected) => {
    expect(redactCredentialPatterns(input)).toBe(expected);
  });

  test("redacts multiple KEY=value pairs on one line independently", () => {
    expect(redactCredentialPatterns("PASSWORD=hunter2 TOKEN=abc123 API_KEY=xyz789 done")).toBe(
      "PASSWORD=[REDACTED] TOKEN=[REDACTED] API_KEY=[REDACTED] done",
    );
  });

  test("finds a credential nested after a non-credential prefix with no separating space", () => {
    // Regression: a naive single-pass regex lets the leading non-credential
    // "config:" candidate greedily consume "DB_PASSWORD=…" as ITS value (one
    // whitespace-free run), which discards the match (name not
    // credential-like) without ever re-trying the nested assignment on its
    // own — silently leaking the credential.
    expect(redactCredentialPatterns("my db config: DB_PASSWORD=Sup3r!Secret#2024 ready")).toBe(
      "my db config: DB_PASSWORD=[REDACTED] ready",
    );
  });

  test("does not redact ordinary prose that merely contains a credential-shaped word", () => {
    for (const query of [
      "rotate the api key procedure",
      "token budget",
      "author: John Doe wrote this",
      "authorization flow docs",
      "explain how oauth works",
      "the password reset flow needs review",
      "update the secret santa spreadsheet",
    ]) {
      expect(redactCredentialPatterns(query)).toBe(query);
    }
  });
});

describe("redactCredentialPatterns — additional credential shapes", () => {
  test("redacts a PEM private-key block, keeping the BEGIN/END markers", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nmore base64 lines\n-----END RSA PRIVATE KEY-----";
    expect(redactCredentialPatterns(pem)).toBe(
      "-----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY-----",
    );
  });

  test("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactCredentialPatterns(`session cookie was ${jwt} in the log`)).toBe(
      "session cookie was [REDACTED] in the log",
    );
  });

  test("redacts GitHub tokens for every ghp_/gho_/ghs_/ghu_/ghr_ prefix", () => {
    for (const prefix of ["ghp", "gho", "ghs", "ghu", "ghr"]) {
      const token = `${prefix}_abcdefghijklmnopqrstuvwxyz012345`;
      expect(redactCredentialPatterns(`token: ${token}`)).toBe("token: [REDACTED]");
    }
  });

  test("redacts Slack tokens for every xoxa-/xoxb-/xoxp-/xoxr- prefix", () => {
    for (const prefix of ["xoxa", "xoxb", "xoxp", "xoxr"]) {
      const token = `${prefix}-1234567890-abcdefghij`;
      expect(redactCredentialPatterns(`slack token ${token} leaked`)).toBe("slack token [REDACTED] leaked");
    }
  });

  test("redacts an AWS access key id", () => {
    expect(redactCredentialPatterns("key id AKIAIOSFODNN7EXAMPLE in the config")).toBe(
      "key id [REDACTED] in the config",
    );
  });

  test("redacts user:pass@ URL userinfo, keeping the scheme and host", () => {
    expect(redactCredentialPatterns("connect to postgres://admin:hunter2@db.example.com/mydb now")).toBe(
      "connect to postgres://[REDACTED]@db.example.com/mydb now",
    );
  });

  test("does not redact an ordinary URL with no userinfo", () => {
    const url = "connect to postgres://db.example.com/mydb now";
    expect(redactCredentialPatterns(url)).toBe(url);
  });
});

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
    for (const [url, echoes] of [
      [
        "https://issuer.test/callback#access_token=oidc%2Ftoken%2Bsentinel",
        ["oidc%2Ftoken%2Bsentinel", "oidc%2ftoken%2bsentinel", "oidc/token+sentinel"],
      ],
      ["https://issuer.test/callback#access_token=space%20token", ["space%20token", "space+token", "space token"]],
      ["https://issuer.test/callback#access_token=plus+token", ["plus%20token", "plus+token", "plus token"]],
      ["https://issuer.test/callback#state=A%20B%20C%2FD%2BE", ["A%20B%20C%2FD%2BE", "A+B%20C%2fD%2BE", "A B C/D+E"]],
      ["https://issuer.test/callback?access_token=A", ["%41%42"]],
    ] as const) {
      const sensitive = collectSensitiveValues([url]);
      for (const echo of echoes) {
        const expected = echo === "%41%42" ? "provider echoed [REDACTED]%42" : "provider echoed [REDACTED]";
        expect(redactSensitiveText(`provider echoed ${echo}`, sensitive), `${url}: ${echo}`).toBe(expected);
      }
    }
  });

  test("handles long malformed percent sequences without rescanning suffixes", () => {
    const malformed = "%FF".repeat(10_000);
    expect(redactSensitiveText(malformed, ["not-present"])).toBe(malformed);
  });
});
