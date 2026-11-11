// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCards,
  checkPrompt,
  harnessLabel,
  hasStarter,
  installedChannel,
  isUnconfigured,
  learningRuns,
  learnPlan,
  learnReceipt,
  pluginChannel,
  pluginLine,
  pluginMatches,
  searchCount,
} from "../src/lib/setup-model.ts";

test("plugins follow Desktop's release stage and match on akm's major and minor", () => {
  assert.equal(pluginChannel("0.10.261105"), "latest");
  assert.equal(pluginChannel("0.10.261105-beta"), "next");
  assert.equal(pluginChannel(undefined), "latest");
  // A saved choice wins over the stage (F14).
  assert.equal(pluginChannel("0.10.261105", "next"), "next");
  assert.equal(pluginChannel("0.10.261105-beta", "latest"), "latest");
  assert.equal(pluginMatches("0.10.261105", "0.10.261020"), true);
  assert.equal(pluginMatches("0.10.261105-beta", "0.10.261020"), true);
  assert.equal(pluginMatches("0.10.261105", "0.9.15"), false);
  assert.equal(pluginMatches("0.10.261105", undefined), null);
});

test("nothing is configured only when there is no bundle", () => {
  assert.equal(isUnconfigured({ bundles: [] }), true);
  assert.equal(isUnconfigured({ bundles: [{}] }), false);
});

test("the starter bundle is recognised by its source", () => {
  const bundle = (name, locator) => ({ name, source: locator ? { kind: "git", locator } : undefined });
  assert.equal(hasStarter([bundle("akm", undefined)]), false);
  assert.equal(hasStarter([bundle("akm-stash", "https://github.com/itlackey/akm-stash")]), true);
});

const detected = (over = {}) => ({
  stashDir: "/x",
  harnesses: [],
  enabled: [],
  modelCalls: { platform: null, description: "off" },
  connection: null,
  learning: { on: false, harness: null, scheduled: false },
  ...over,
});
const host = (bun, harnesses) => ({ cli: { installed: true, runnable: true }, bun, harnesses });
test("one card per harness found, with the plugin's version, the Bun gate and akm's own view for learning", () => {
  const cards = agentCards(
    host({ installed: false, installCommand: "x" }, [
      { id: "claude", installed: true, runnable: true, version: "2.1.0", plugin: { state: "missing" } },
      { id: "codex", installed: true, runnable: true, plugin: { state: "installed", version: "0.9.1" } },
      { id: "opencode", installed: true, runnable: true, plugin: { state: "configured", spec: "akm-opencode@next" } },
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
      connection: null,
      learning: { on: false, harness: null, scheduled: false },
    },
  );
  assert.deepEqual(
    cards.map((card) => [card.id, card.state, card.needsBun, card.learning]),
    [
      [
        "claude",
        "ready",
        true,
        { available: true, enabled: false, note: "model calls are limited to reading and searching" },
      ],
      ["codex", "connected", true, { available: false, enabled: false, note: "" }],
      [
        "opencode",
        "connected",
        false,
        {
          available: true,
          enabled: true,
          note: "Model work on opencode cannot be restricted: it can edit files and run commands.",
        },
      ],
    ],
  );
  assert.deepEqual(cards[1].plugin, { text: "AKM plugin 0.9.1", mismatch: true });
  assert.deepEqual(cards[2].plugin, { text: "AKM plugin akm-opencode@next", mismatch: false });
  assert.deepEqual(
    cards.map((card) => card.name),
    ["Claude Code", "Codex", "OpenCode"],
  );
});

test("OpenCode 2 is the same program told apart by its major, and the plugin rows read as sentences (F2, F14, F18)", () => {
  assert.equal(harnessLabel({ id: "opencode", major: 2 }), "OpenCode 2");
  assert.equal(harnessLabel({ id: "opencode", major: 1 }), "OpenCode");
  assert.equal(harnessLabel({ id: "codex" }), "Codex");
  assert.equal(pluginLine({ id: "opencode", installed: false }), "Harness not found");
  assert.equal(pluginLine({ id: "claude", installed: true, runnable: false }), "Harness could not start");
  assert.equal(pluginLine({ id: "claude", installed: true, runnable: true }), "AKM plugin not checked");
  assert.equal(
    pluginLine({
      id: "claude",
      installed: true,
      runnable: true,
      plugin: { state: "installed", version: "0.10.261118" },
    }),
    "AKM plugin 0.10.261118 installed",
  );
  assert.equal(
    pluginLine({
      id: "claude",
      installed: true,
      runnable: true,
      plugin: { state: "disabled", version: "0.10.261118" },
    }),
    "AKM plugin 0.10.261118 installed but turned off in the harness",
  );
  assert.equal(
    pluginLine({
      id: "opencode",
      installed: true,
      runnable: true,
      plugin: { state: "configured", spec: "akm-opencode@next" },
    }),
    "AKM plugin akm-opencode@next configured (OpenCode installs it when it starts)",
  );
  assert.equal(
    pluginLine({ id: "codex", installed: true, runnable: true, plugin: { state: "unknown" } }),
    "AKM plugin could not be verified",
  );
  const plugins = [
    { harness: "claude-code", channel: "next" },
    { harness: "codex", channel: "latest" },
    { harness: "opencode", channel: "pinned" },
    { harness: "opencode-v2", channel: "unknown" },
  ];
  // The channel finishes the row's sentence in words, and only for a plugin that is there.
  const present = (id, state, major) => ({ id, installed: true, runnable: true, major, plugin: { state } });
  assert.equal(installedChannel(present("claude", "installed"), plugins), "on the prerelease channel");
  assert.equal(installedChannel(present("codex", "disabled"), plugins), "on the stable channel");
  assert.equal(installedChannel(present("opencode", "configured", 1), plugins), "pinned to one version");
  assert.equal(installedChannel(present("opencode", "configured", 2), plugins), undefined);
  assert.equal(installedChannel(present("claude", "installed"), undefined), undefined);
  assert.equal(installedChannel(present("claude", "missing"), plugins), undefined);
  assert.equal(installedChannel(present("claude", "unknown"), plugins), undefined);
});

test("a plugin that is turned off, or that the harness cannot report, is not offered an install", () => {
  const cards = agentCards(
    host({ installed: true, installCommand: "x" }, [
      { id: "claude", installed: true, runnable: true, plugin: { state: "unknown" } },
      { id: "codex", installed: true, runnable: true, plugin: { state: "disabled", version: "0.10.1" } },
    ]),
    "0.10.261105",
    { ...detected(), harnesses: [] },
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
  assert.match(checkPrompt("opencode", "deploy"), /akm_search tool/);
  assert.equal(searchCount({ daily: [{ searches: 2 }, { searches: 3 }] }), 5);
  assert.equal(searchCount(null), 0);
});

const blank = { endpoint: "", model: "", keyEnv: "" };
test("learning is off unless turned on, and setup writes the off state with whatever else it applies", () => {
  const off = learnPlan(detected(), ["claude"], blank);
  assert.deepEqual([off.on, off.changed, off.learning, off.problem], [false, false, { on: false }, undefined]);
  // An on state nobody touched is left as it is: it may run somewhere this page does not list.
  const on = learnPlan(
    detected({ learning: { on: true, harness: null, scheduled: false }, connection: "lab" }),
    [],
    blank,
  );
  // An on state is sent whenever setup applies, so a save gives it its improve task.
  assert.deepEqual([on.on, on.changed, on.learning], [true, false, { on: true }]);
});

test("the switch alone is not running: a host with nowhere to run reads off", () => {
  const nowhere = detected({ learning: { on: true, harness: null, scheduled: false } });
  assert.equal(learningRuns(nowhere), false);
  assert.deepEqual(learnPlan(nowhere, [], blank).learning, { on: false });
  assert.equal(learningRuns({ ...nowhere, connection: "lab" }), true);
  assert.equal(learningRuns(detected({ learning: { on: false, harness: "claude", scheduled: false } })), false);
});

test("turning learning on never lands on an agent the person has not picked", () => {
  const off = detected({ learning: { on: false, harness: "claude", scheduled: false } });
  const plan = learnPlan(off, ["claude"], { ...blank, learn: true });
  assert.equal(plan.where, "internal");
  assert.match(plan.problem, /model connection/);
});

test("learning on needs a connection or an agent, and says why in one line", () => {
  const none = learnPlan(detected(), ["claude"], { ...blank, learn: true });
  assert.match(none.problem, /needs a model connection/);
  // Not turned on: off is written still, so that an agent enabled in the same apply does not take akm's model calls.
  assert.deepEqual([none.changed, none.learning], [false, { on: false }]);
  const wasOn = learnPlan(detected({ learning: { on: true, harness: "claude", scheduled: false } }), [], {
    ...blank,
    where: "internal",
  });
  assert.deepEqual([wasOn.problem !== undefined, wasOn.learning], [true, undefined]);
  const typed = learnPlan(detected(), [], {
    learn: true,
    endpoint: " http://localhost:1/v1 ",
    model: "m",
    keyEnv: " LAB_KEY ",
  });
  assert.equal(typed.problem, undefined);
  assert.deepEqual(typed.connection, { endpoint: "http://localhost:1/v1", model: "m", apiKeyEnv: "LAB_KEY" });
  assert.deepEqual([typed.changed, typed.learning], [true, { on: true }]);
  // Half a connection is not one, and a key is only ever a variable's name.
  assert.equal(
    learnPlan(detected(), [], { learn: true, endpoint: "http://x", model: "", keyEnv: "K" }).connection,
    undefined,
  );
  const configured = learnPlan(detected({ connection: "lab" }), [], { ...blank, learn: true });
  assert.deepEqual([configured.problem, configured.learning], [undefined, { on: true }]);
});

test("learning on an agent names its platform, and an agent that is not allowed falls back to akm itself", () => {
  const agent = learnPlan(detected(), ["claude", "codex"], { ...blank, learn: true, where: "codex" });
  assert.deepEqual([agent.where, agent.learning], ["codex", { on: true, harness: "codex" }]);
  const gone = learnPlan(detected({ connection: "lab" }), ["claude"], { ...blank, learn: true, where: "codex" });
  assert.deepEqual([gone.where, gone.learning], ["internal", { on: true }]);
  // On through an agent the page has no card for: left as it is, with no problem, until the person picks.
  const elsewhere = learnPlan(
    detected({ learning: { on: true, harness: "aider", scheduled: false } }),
    ["claude"],
    blank,
  );
  assert.deepEqual(
    [elsewhere.where, elsewhere.problem, elsewhere.learning],
    ["aider", undefined, { on: true, harness: "aider" }],
  );
  const back = learnPlan(detected({ learning: { on: true, harness: "codex", scheduled: false } }), ["codex"], {
    ...blank,
    learn: false,
  });
  assert.deepEqual([back.changed, back.learning], [true, { on: false }]);
});

test("the receipt says only what akm reports afterwards", () => {
  assert.equal(learnReceipt(detected(), false, undefined), "Background learning is off.");
  assert.equal(learnReceipt(detected(), true, undefined), "Background learning stays off.");
  const on = detected({
    learning: { on: true, harness: null, scheduled: false },
    connection: "lab",
    modelCalls: { platform: null, description: 'connection "lab" (m).' },
  });
  assert.equal(
    learnReceipt(on, true, undefined),
    'Background learning is on and runs on akm itself: connection "lab" (m).',
  );
  const agent = detected({
    learning: { on: true, harness: "claude", scheduled: false },
    modelCalls: { platform: "claude", description: 'harness "default", limited to reading and searching' },
  });
  assert.match(learnReceipt(agent, true, "Claude Code"), /runs on Claude Code: harness "default", limited/);
});
