// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 08 "surfaces" advisory group for `akm health` (egress-endpoints). Every collector is silent (`undefined`) when there is
 * nothing to report, mirroring the shipped `stash-git-exposure` advisory; only
 * `egress-endpoints` emits a pass-status informational entry whenever any
 * remote endpoint is configured.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectEgressAdvisory } from "../../../src/commands/health/egress";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("collectEgressAdvisory (08 surfaces 3/9)", () => {
  test("lists enabled registries, remote sources, LLM and embedding endpoints", () => {
    const adv = collectEgressAdvisory({
      registries: [
        { url: "https://example.com/index.json", name: "reg", enabled: true },
        { url: "https://disabled.example.com", name: "off", enabled: false },
      ],
      bundles: {
        team: { git: "https://github.com/x/y.git" },
        local: { path: "/stash" },
      },
      connections: { judge: { endpoint: "http://127.0.0.1:1234/v1/chat/completions" } },
      embedding: { endpoint: "http://127.0.0.1:8080" },
    });
    expect(adv?.name).toBe("egress-endpoints");
    expect(adv?.status).toBe("pass");
    const endpoints = adv?.evidence?.endpoints as string[];
    expect(endpoints).toContain("registry reg: https://example.com/index.json");
    expect(endpoints).toContain("source team (git): https://github.com/x/y.git");
    expect(endpoints).toContain("connection judge: http://127.0.0.1:1234/v1/chat/completions");
    expect(endpoints).toContain("embedding: http://127.0.0.1:8080");
    expect(endpoints.some((e) => e.includes("disabled.example.com"))).toBe(false);
    expect(endpoints.some((e) => e.includes("/stash"))).toBe(false);
  });

  test("silent when no remote endpoints are configured", () => {
    expect(collectEgressAdvisory({ bundles: { local: { path: "/stash" } } })).toBeUndefined();
    expect(collectEgressAdvisory(undefined)).toBeUndefined();
  });

  test("never prints a credential carried in a configured URL", () => {
    const adv = collectEgressAdvisory({
      bundles: { team: { git: "https://bot:hunter2secret@git.example.com/team/stash.git" } },
      connections: { lab: { endpoint: "https://llm.example.com/v1?token=tok-abc123secret&x=1" } },
      embedding: { endpoint: "https://embed.example.com/v1?api_key=key-zz9secret" },
    });
    const text = JSON.stringify(adv);
    for (const secret of ["hunter2secret", "tok-abc123secret", "key-zz9secret"]) expect(text).not.toContain(secret);
    // The destinations themselves stay readable.
    for (const host of ["git.example.com/team/stash.git", "llm.example.com/v1", "embed.example.com/v1"])
      expect(text).toContain(host);
  });
});
