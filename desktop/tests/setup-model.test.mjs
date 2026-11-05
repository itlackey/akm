// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCards,
  checkPrompt,
  hasStarter,
  isUnconfigured,
  pluginChannel,
  pluginMatches,
  searchCount,
} from "../src/lib/setup-model.ts";

test("plugins follow Desktop's release stage and match on akm's major and minor", () => {
  assert.equal(pluginChannel("0.10.261105"), "latest");
  assert.equal(pluginChannel("0.10.261105-beta"), "next");
  assert.equal(pluginChannel(undefined), "latest");
  assert.equal(pluginMatches("0.10.261105", "0.10.261020"), true);
  assert.equal(pluginMatches("0.10.261105-beta", "0.10.261020"), true);
  assert.equal(pluginMatches("0.10.261105", "0.9.15"), false);
  assert.equal(pluginMatches("0.10.261105", undefined), null);
});

test("nothing is configured only when there is no bundle and no working library", () => {
  assert.equal(isUnconfigured({ bundles: [], workingStash: null }), true);
  assert.equal(isUnconfigured({ bundles: [{}], workingStash: null }), false);
  assert.equal(isUnconfigured({ bundles: [], workingStash: { path: "/x" } }), false);
});

test("the starter bundle is recognised by its source", () => {
  const bundle = (name, locator) => ({ name, source: locator ? { kind: "git", locator } : undefined });
  assert.equal(hasStarter([bundle("akm", undefined)]), false);
  assert.equal(hasStarter([bundle("akm-stash", "https://github.com/itlackey/akm-stash")]), true);
});

const host = (bun, harnesses) => ({ cli: { installed: true, runnable: true }, bun, harnesses });
test("one card per harness found, with the plugin's version, the Bun gate and akm's own view for learning", () => {
  const cards = agentCards(
    host({ installed: false, installCommand: "x" }, [
      { id: "claude", installed: true, runnable: true, version: "2.1.0", plugin: { state: "missing" } },
      { id: "codex", installed: true, runnable: true, plugin: { state: "installed", version: "0.9.1" } },
      { id: "opencode", installed: true, runnable: true, plugin: { state: "configured", spec: "akm-opencode@next" } },
      { id: "opencode2", installed: false },
    ]),
    "0.10.261105",
    {
      stashDir: "/x",
      harnesses: [
        { platform: "claude", path: "/bin/claude", modelWorkNote: "model calls are limited to reading and searching" },
        {
          platform: "opencode",
          path: "/bin/opencode",
          modelWorkNote: "Model work on opencode cannot be restricted: it can edit files and run commands.",
        },
      ],
      enabled: ["opencode"],
      modelCalls: { platform: "opencode", description: "harness" },
    },
  );
  assert.deepEqual(
    cards.map((card) => [card.id, card.state, card.needsBun, card.learning]),
    [
      [
        "claude",
        "ready",
        true,
        { available: true, enabled: false, active: false, note: "model calls are limited to reading and searching" },
      ],
      ["codex", "connected", true, { available: false, enabled: false, active: false, note: "" }],
      [
        "opencode",
        "connected",
        false,
        {
          available: true,
          enabled: true,
          active: true,
          note: "Model work on opencode cannot be restricted: it can edit files and run commands.",
        },
      ],
    ],
  );
  assert.deepEqual(cards[1].plugin, { text: "AKM plugin 0.9.1", mismatch: true });
  assert.deepEqual(cards[2].plugin, { text: "AKM plugin akm-opencode@next", mismatch: false });
});

test("a plugin that is turned off, or that the harness cannot report, is not offered an install", () => {
  const cards = agentCards(
    host({ installed: true, installCommand: "x" }, [
      { id: "claude", installed: true, runnable: true, plugin: { state: "unknown" } },
      { id: "codex", installed: true, runnable: true, plugin: { state: "disabled", version: "0.10.1" } },
    ]),
    "0.10.261105",
    { stashDir: "/x", harnesses: [], enabled: [], modelCalls: { platform: null, description: "off" } },
  );
  assert.deepEqual(
    cards.map((card) => [card.state, card.needsBun]),
    [
      ["unverified", false],
      ["disabled", false],
    ],
  );
});

test("each harness gets a prompt for its own surface, and searches are counted across days", () => {
  assert.equal(checkPrompt("claude", "deploy"), "/akm-search deploy");
  assert.match(checkPrompt("codex", "deploy"), /akm skill/);
  assert.match(checkPrompt("opencode2", "deploy"), /akm_search tool/);
  assert.equal(searchCount({ daily: [{ searches: 2 }, { searches: 3 }] }), 5);
  assert.equal(searchCount(null), 0);
});
