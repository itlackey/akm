// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 08-F1: the `stash-git-exposure` health advisory must fire ONLY when env/secret
 * assets are git-tracked AND a remote is configured (the leak moment) — not on
 * the tracked-but-no-remote private-backup opt-in, and not when nothing is
 * tracked. Uses an injected git seam so no real subprocess is spawned.
 */

import { describe, expect, test } from "bun:test";
import { collectStashExposureAdvisory, type GitRunner } from "../../../src/commands/health/stash-exposure";

/** Build a fake git runner from canned per-command outputs. */
function fakeGit(opts: { isRepo?: boolean; tracked?: string[]; remotes?: string[] }): GitRunner {
  return (_stashDir, args) => {
    if (args[0] === "rev-parse") return { ok: opts.isRepo !== false, stdout: "true" };
    if (args[0] === "ls-files") return { ok: true, stdout: (opts.tracked ?? []).join("\n") };
    if (args[0] === "remote") return { ok: true, stdout: (opts.remotes ?? []).join("\n") };
    return { ok: false, stdout: "" };
  };
}

describe("collectStashExposureAdvisory (08-F1)", () => {
  test("warns when env/secret assets are tracked AND a remote is configured", () => {
    const adv = collectStashExposureAdvisory(
      "/stash",
      fakeGit({ tracked: ["env/prod.env", "secrets/signing.key"], remotes: ["origin"] }),
    );
    expect(adv?.name).toBe("stash-git-exposure");
    expect(adv?.status).toBe("warn");
    expect(adv?.evidence?.trackedSecretFiles).toEqual(["env/prod.env", "secrets/signing.key"]);
  });

  test("silent when tracked but NO remote (private-backup opt-in must not nag)", () => {
    const adv = collectStashExposureAdvisory("/stash", fakeGit({ tracked: ["env/prod.env"], remotes: [] }));
    expect(adv).toBeUndefined();
  });

  test("silent when nothing tracked even with a remote (e.g. env/ is gitignored)", () => {
    const adv = collectStashExposureAdvisory("/stash", fakeGit({ tracked: [], remotes: ["origin"] }));
    expect(adv).toBeUndefined();
  });

  test("silent when the stash is not a git repo", () => {
    const adv = collectStashExposureAdvisory("/stash", fakeGit({ isRepo: false, remotes: ["origin"] }));
    expect(adv).toBeUndefined();
  });
});
