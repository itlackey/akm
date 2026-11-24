// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Distill reads its input asset and the assets search finds near it through the asset facade, by ref (F36): the
 * prompt carries the same text as the files hold.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmDistill } from "../../../../src/commands/improve/distill";
import { type AkmConfig, saveConfig } from "../../../../src/core/config/config";
import type { readEvents } from "../../../../src/core/events";
import { akmIndex } from "../../../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

const emptyEvents = (() => ({ events: [], nextOffset: 0 })) as unknown as typeof readEvents;

function write(rel: string, content: string): void {
  const file = path.join(storage.stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

describe("distill reads by ref (F36)", () => {
  test("the input memory and a related knowledge note reach the prompt as their files hold them", async () => {
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      connections: {
        default: { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "test-model" } },
      },
      improve: {
        strategy: "test",
        strategies: { test: { processes: { distill: { enabled: true, qualityGate: { enabled: false } } } } },
      },
    } as AkmConfig;
    saveConfig(config);
    write("memories/vpn-deploy.md", "---\ndescription: VPN deploy\n---\n\nThe deploy failed until the VPN was up.\n");
    write(
      "knowledge/vpn-deploy-guide.md",
      "---\ndescription: Deploys need the VPN\n---\n\nBring the VPN up before any deploy; the deploy host is private.\n",
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });
    let user = "";

    await akmDistill({
      ref: "memories/vpn-deploy",
      config,
      stashDir: storage.stashDir,
      readEventsFn: emptyEvents,
      chat: async (_cfg, messages) => {
        user = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
        return "NONE";
      },
    });

    expect(user).toContain("The deploy failed until the VPN was up.");
    expect(user).toContain("Bring the VPN up before any deploy; the deploy host is private.");
  });
});
