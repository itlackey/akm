// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The setup summary is read off the table `akm info` and `akm health` print, so
 * it cannot say something they do not: a pin that sends improve to another
 * connection is in the summary too.
 */

import { describe, expect, test } from "bun:test";
import { type ProcessRow, targetRows } from "../../src/commands/targets";
import type { AkmConfig } from "../../src/core/config/config";
import { describeRuns } from "../../src/setup/summary";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";

const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });
const MODELS = { fast: "small", balanced: "mid", reasoning: "big" };

describe("describeRuns", () => {
  test("names the connection and model each kind of work resolves to, as the table does", () => {
    const config = cfg({
      connections: {
        default: { endpoint: "http://a/v1", models: MODELS },
        second: { endpoint: "http://b/v1", models: { fast: "s-small", balanced: "s-mid", reasoning: "s-big" } },
      },
      improve: { connection: "second" },
    });

    const runs = describeRuns(config);
    const improve = targetRows({ config }).find(
      (r): r is ProcessRow => r.type === "process" && r.process === "improve",
    );

    expect(improve).toMatchObject({ target: "second", model: "s-small" });
    expect(runs.modelCalls).toBe('connection "second" (s-small)');
    // Agent work is not pinned: the default connection, under akm's own runtime.
    expect(runs.agentWork).toBe('akm\'s own runtime over connection "default" (mid)');
  });

  test("a harness: agent work on it, model calls on it with the read-only note", () => {
    const runs = describeRuns(cfg({ harnesses: { default: { platform: "claude" }, codex: {} } }));
    expect(runs.agentWork).toContain('harness "default"');
    expect(runs.modelCalls).toContain('harness "default"');
    expect(runs.modelCalls).toContain("read-only");
    // codex is confinable since step 3 (`--sandbox read-only`); gemini is not.
    const gemini = describeRuns(cfg({ harnesses: { gemini: {} } }));
    expect(gemini.modelCalls).toContain(
      'Model work on "gemini" cannot be restricted: it can edit files and run commands.',
    );
  });

  test("an OpenCode harness is read-only by the major of its configured bin, not of the opencode on PATH", () => {
    // Every binary but the harness's own is OpenCode 1, as the one on PATH is.
    fakeOpencodeMajor((bin) => (bin === "/opt/oc2/opencode" ? "opencode v2.0.26" : "1.18.34"));
    expect(describeRuns(cfg({ harnesses: { opencode: { bin: "/opt/oc2/opencode" } } })).modelCalls).toContain(
      ", read-only",
    );
    expect(describeRuns(cfg({ harnesses: { opencode: {} } })).modelCalls).toContain(
      'Model work on "opencode" cannot be restricted',
    );
  });

  test("nothing configured is off, and a connection with no model yet is not nothing", () => {
    expect(describeRuns(cfg())).toEqual({
      modelCalls: "off: no connection or harness is configured",
      agentWork: "off: no connection or harness is configured",
      embeddings: "off",
    });
    const noModel = describeRuns(cfg({ connections: { default: { endpoint: "http://a/v1" } } }));
    expect(noModel.modelCalls).toContain('Connection "default" lists no models');
    expect(noModel.agentWork).toContain("akm models set");
  });

  test("embeddings: built-in embedder, a model on the connection, or an endpoint of its own", () => {
    const base = {
      connections: { default: { endpoint: "http://a/v1", models: MODELS } },
      semanticSearchMode: "auto" as const,
    };
    expect(describeRuns(cfg(base)).embeddings).toContain("built-in local embedder");
    expect(describeRuns(cfg({ ...base, embedding: { model: "nomic-embed-text" } })).embeddings).toBe(
      'nomic-embed-text on connection "default"',
    );
    expect(describeRuns(cfg({ ...base, embedding: { endpoint: "http://e/v1", model: "e5" } })).embeddings).toBe(
      "e5 at http://e/v1",
    );
  });
});
