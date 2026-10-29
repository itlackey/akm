// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A connection endpoint can carry a username and password in its URL. Every
 * diagnostic that names an endpoint (the config-load warning, a failed model
 * call, a failed rerank, setup's model listing) names it without that
 * credential, and the config-load warning is keyed by the redacted URL as well.
 * The tests read what reaches the warning sink, not only the final result.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseAndValidateConfigText } from "../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { chatCompletion } from "../src/llm/client";
import { rerankDocuments } from "../src/llm/rerank-client";
import { listModels } from "../src/setup/steps/connection-shared";
import { withMockedFetch } from "./_helpers/sandbox";

const PASSWORD = "SYNTHETIC_URL_PASSWORD";
const WITH_USERINFO = `https://review-user:${PASSWORD}@example.invalid/v1`;

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  _resetWarnOnceForTests();
});

describe("an endpoint that embeds a username and password", () => {
  test("is warned about at config load without the credential, once for the same server", () => {
    parseAndValidateConfigText(
      JSON.stringify({
        configVersion: "0.9.0",
        connections: {
          one: { endpoint: WITH_USERINFO, models: { fast: "m" } },
          two: { endpoint: `https://review-user:another-password@example.invalid/v1`, models: { fast: "m" } },
        },
      }),
    );
    const warned = warnings.filter((w) => w.includes("embeds a username/password"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("example.invalid");
    expect(warnings.join("\n")).not.toContain(PASSWORD);
    expect(warnings.join("\n")).not.toContain("another-password");
  });

  test("is named without it when a model call fails", async () => {
    const failure = await withMockedFetch(
      () =>
        chatCompletion({ endpoint: WITH_USERINFO, model: "m" }, [{ role: "user", content: "hi" }], {}).then(
          () => undefined,
          (error: Error) => error.message,
        ),
      () => new Response("boom", { status: 500 }),
    );
    expect(failure).toContain("example.invalid");
    expect(failure).not.toContain(PASSWORD);
  });

  test("is named without it when a rerank fails", async () => {
    const failure = await withMockedFetch(
      () =>
        rerankDocuments({ endpoint: WITH_USERINFO, model: "r" } as never, "q", ["a"]).then(
          () => undefined,
          (error: Error) => error.message,
        ),
      () => new Response("boom", { status: 500 }),
    );
    expect(failure).toContain("example.invalid");
    expect(failure).not.toContain(PASSWORD);
  });

  test("is named without it when setup cannot list its models", async () => {
    await withMockedFetch(
      () => listModels(WITH_USERINFO, undefined, false),
      () => new Response("no", { status: 404 }),
    );
    expect(warnings.filter((w) => w.includes("Could not list models"))).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain(PASSWORD);
  });
});
