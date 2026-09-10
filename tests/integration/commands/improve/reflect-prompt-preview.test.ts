// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #952 — `renderReflectPromptPreview` (reflect.ts) renders the composed
 * reflect prompt for exactly one asset with no engine dispatch. `akm improve
 * <ref> --show-prompt` (improve-cli.ts) is its CLI surface.
 *
 * Under tests/integration (not tests/) because the read-only helpers reused
 * here (readRecentFeedback -> readEvents) open the real state.db, per the
 * ORG-03..06 classification rule in AGENTS.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { improveCommand } from "../../../../src/commands/improve/improve-cli";
import { renderReflectPromptPreview } from "../../../../src/commands/improve/reflect";
import { appendEvent } from "../../../../src/core/events";
import { REFLECT_TRUNCATION_MARKER } from "../../../../src/integrations/agent/prompts";
import { writeLesson } from "../../../_helpers/assets";
import { makeConfig } from "../../../_helpers/factories";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("renderReflectPromptPreview (#952)", () => {
  test("renders the composed prompt for a fixture asset with the #952 framing and no engine call", async () => {
    const stashDir = storage.stashDir;
    writeLesson(stashDir, "test-lesson", "existing description", "existing usage");
    appendEvent({
      eventType: "feedback",
      ref: "lessons/test-lesson",
      metadata: { signal: "outdated", reason: "the example command no longer works" },
    });

    const config = withTestImproveLlm(makeConfig(stashDir));

    const preview = await withMockedFetch(
      () =>
        renderReflectPromptPreview({
          ref: "lessons/test-lesson",
          improveProfile: {},
          config,
          stashDir,
        }),
      () => {
        throw new Error("renderReflectPromptPreview must never call fetch — it makes no engine call");
      },
    );

    expect(preview.ref).toBe("lessons/test-lesson");
    expect(preview.engine).toBe("test-improve-llm");

    // #952 — feedback is framed as an unverified report, not a fact, and the
    // actual feedback signal is present so the field can see it echoed in.
    expect(preview.prompt).toContain("It is a signal to investigate, not a fact to insert.");
    expect(preview.prompt).toContain("the example command no longer works");

    // #952 — the model is told never to emit the truncation marker or any
    // content from outside the shown asset. The marker's literal text is
    // quoted once inside that instruction; since this lesson body is short,
    // the asset content itself was never truncated — the marker does not
    // appear a second time as if it were part of the shown content, and the
    // content section is introduced as verbatim rather than "(first N chars)".
    expect(preview.prompt).toContain("Never include the truncation marker");
    expect(preview.prompt).toContain("Current asset content (verbatim):");
    expect(preview.prompt.split(REFLECT_TRUNCATION_MARKER).length - 1).toBe(1);
  });

  test("rejects a missing ref", async () => {
    const config = withTestImproveLlm(makeConfig(storage.stashDir));
    await expect(
      renderReflectPromptPreview({ improveProfile: {}, config, stashDir: storage.stashDir }),
    ).rejects.toThrow(/requires options\.ref/);
  });

  test("`akm improve` registers --show-prompt (#952)", () => {
    const args = improveCommand.args as Record<string, { type?: string; default?: unknown }>;
    expect(args["show-prompt"]).toMatchObject({ type: "boolean", default: false });
  });
});
