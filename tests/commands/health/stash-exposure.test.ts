// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 08-F1: the `stash-git-exposure` health advisory must fire ONLY when env/secret
 * assets are git-tracked AND a remote is configured (the leak moment) — not on
 * the tracked-but-no-remote private-backup opt-in, and not when nothing is
 * tracked. Uses an injected git seam so no real subprocess is spawned.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStashExposureAdvisory, type GitRunner } from "../../../src/commands/health/stash-exposure";
import { STASH_GITIGNORE_TRACK_SECRETS_MARKER } from "../../../src/commands/sources/stash-skeleton";

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

describe("collectStashExposureAdvisory intentional tracking marker (#1291)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function stashWithGitignore(content?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-exposure-"));
    dirs.push(dir);
    if (content !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), content);
    return dir;
  }
  const exposed = { tracked: ["secrets/example.key"], remotes: ["origin"] };

  test("without the marker the advisory prescribes untracking and names the opt-out", () => {
    const adv = collectStashExposureAdvisory(stashWithGitignore("node_modules/\n"), fakeGit(exposed));
    expect(adv?.status).toBe("warn");
    expect(adv?.message).toContain("git rm --cached");
    expect(adv?.message).toContain(STASH_GITIGNORE_TRACK_SECRETS_MARKER);
    expect(adv?.evidence).toMatchObject({ trackedSecretFiles: ["secrets/example.key"] });
  });

  test("with the marker, acknowledged tracking is not warned about", () => {
    const dir = stashWithGitignore(`node_modules/\n${STASH_GITIGNORE_TRACK_SECRETS_MARKER}\n`);
    expect(collectStashExposureAdvisory(dir, fakeGit(exposed))).toBeUndefined();
  });

  test("missing or unreadable .gitignore is treated as no marker", () => {
    const adv = collectStashExposureAdvisory(stashWithGitignore(), fakeGit(exposed));
    expect(adv?.message).toContain("git rm --cached");
    const asDir = stashWithGitignore();
    fs.mkdirSync(path.join(asDir, ".gitignore"));
    expect(collectStashExposureAdvisory(asDir, fakeGit(exposed))?.message).toContain("git rm --cached");
  });

  test("unreadable git metadata yields no advisory", () => {
    const dir = stashWithGitignore(`${STASH_GITIGNORE_TRACK_SECRETS_MARKER}\n`);
    const broken: GitRunner = () => ({ ok: false, stdout: "" });
    expect(collectStashExposureAdvisory(dir, broken)).toBeUndefined();
  });
});
