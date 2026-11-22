// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reader of OpenCode 1's `run --format json` stream, against output recorded from OpenCode 1.18.25
 * (tests/fixtures/opencode1-run). `*-default.out` is what the same run printed in the default format: the reader's
 * reply must be those bytes.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readOpencode1Run } from "../src/integrations/harnesses/opencode/run-events";

const fixture = (name: string): string =>
  fs.readFileSync(path.join(import.meta.dir, "fixtures/opencode1-run", name), "utf8");

describe("a turn that ended on a refused tool call", () => {
  const report = readOpencode1Run(fixture("oc1-json.out"));

  test("the reply is what the default format printed", () => {
    expect(report.reply).toBe(fixture("oc1-default.out"));
  });

  test("is unfinished: OpenCode's last step finished with tool-calls, and the failed tool carries OpenCode's message", () => {
    expect(report.unfinished).toContain("tool-calls");
    expect(report.unfinished).toContain("read failed: The user rejected permission to use this specific tool call.");
    expect(report.errors).toEqual([]);
  });

  test("carries the stream's session id", () => {
    expect(report.sessionId).toBe("ses_e015daf81ffeBDYwsN7qEcmDWR");
  });
});

describe("a two-step run that finished", () => {
  const report = readOpencode1Run(fixture("oc1-ok.out"));

  test("the reply is both texts, as the default format printed them, and the turn is finished", () => {
    expect(report.reply).toBe(fixture("oc1-ok-default.out"));
    expect(report.unfinished).toBeUndefined();
    expect(report.errors).toEqual([]);
  });

  test("a failed tool in an earlier step does not make the turn unfinished", () => {
    const events = fixture("oc1-json.out").trimEnd().split("\n");
    const finished = [...events.slice(0, 3), ...fixture("oc1-ok.out").trimEnd().split("\n").slice(3)].join("\n");
    expect(readOpencode1Run(finished).unfinished).toBeUndefined();
  });
});

describe("a provider error", () => {
  const report = readOpencode1Run(fixture("oc1-error.out"));

  test("is OpenCode's own message, and the reply is what the default format printed (nothing)", () => {
    expect(report.errors).toEqual(["fake provider refused the request"]);
    expect(report.reply).toBe(fixture("oc1-error-default.out"));
  });
});

describe("what is not an event", () => {
  test("a line that is not an event stays in the reply, in place", () => {
    const [start, text, ...rest] = fixture("oc1-ok.out").trimEnd().split("\n");
    const stream = [start, "plugin says hello", text, '{"type":"text","note":"no session"}', ...rest].join("\n");
    expect(readOpencode1Run(stream).reply).toBe(
      `plugin says hello\nI will read the file now.\n{"type":"text","note":"no session"}\nAfter the refusal I stop.\n`,
    );
  });

  test("a stream with no step_finish is unfinished, with that reason", () => {
    const [start, text] = fixture("oc1-ok.out").trimEnd().split("\n");
    expect(readOpencode1Run([start, text].join("\n")).unfinished).toBe("OpenCode reported no finished step");
    expect(readOpencode1Run("").unfinished).toBe("OpenCode reported no finished step");
  });

  test("an empty text part prints nothing, and reasoning is not part of the reply", () => {
    const base = { sessionID: "s" };
    const stream = [
      { type: "step_start", ...base, part: {} },
      { type: "reasoning", ...base, part: { text: "thinking" } },
      { type: "text", ...base, part: { text: "  \n" } },
      { type: "text", ...base, part: { text: "  answer  " } },
      { type: "step_finish", ...base, part: { reason: "stop" } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(readOpencode1Run(stream)).toEqual({ reply: "answer\n", sessionId: "s", errors: [] });
  });
});
