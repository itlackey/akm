// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { bundleSourceId } from "../src/core/config/config-sources";
import type { AkmConfig } from "../src/core/config/config-types";
import {
  activeSchedulerActivations,
  isSchedulerRefEnabled,
  revokeSchedulerActivationsForBundle,
} from "../src/tasks/activation-config";

function config(path: string, enabled = true): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { team: { path, ...(enabled ? {} : { enabled: false }) } },
    ...(enabled ? { defaultBundle: "team" } : {}),
  };
}

describe("source-bound scheduler activation", () => {
  test("ordinary content updates retain a grant, but replacing the bundle locator does not", () => {
    const original = config("/tmp/akm-team-original");
    const activation = {
      kind: "task" as const,
      ref: "team//tasks/nightly",
      sourceId: bundleSourceId(original, "team"),
    };
    const sameOrigin = { ...original, scheduler: { enabled: [activation] } };
    expect(isSchedulerRefEnabled(sameOrigin, "task", activation.ref)).toBe(true);

    const replaced = { ...config("/tmp/akm-team-replaced"), scheduler: { enabled: [activation] } };
    expect(isSchedulerRefEnabled(replaced, "task", activation.ref)).toBe(false);
    expect(activeSchedulerActivations(replaced)).toEqual([]);
  });

  test("mutable website fetch policy is not part of the approved source identity", () => {
    const original: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaultBundle: "docs",
      bundles: { docs: { website: { url: "https://docs.example.com", maxDepth: 2 } } },
    };
    const changedPolicy: AkmConfig = {
      ...original,
      bundles: {
        docs: { website: { url: "https://docs.example.com", maxDepth: 8, respectRobots: true } },
      },
    };

    expect(bundleSourceId(changedPolicy, "docs")).toBe(bundleSourceId(original, "docs"));
  });

  test("adapter detection is interpretation policy, not source identity", () => {
    const original = config("/tmp/akm-team-adapter");
    const detected: AkmConfig = {
      ...original,
      bundles: {
        team: {
          path: "/tmp/akm-team-adapter",
          components: { content: { root: ".", adapter: "akm" } },
        },
      },
    };

    expect(bundleSourceId(detected, "team")).toBe(bundleSourceId(original, "team"));
  });

  test("disabled bundles are inert and removal revokes their grants", () => {
    const original = config("/tmp/akm-team-disabled");
    const activation = {
      kind: "task" as const,
      ref: "team//tasks/nightly",
      sourceId: bundleSourceId(original, "team"),
    };
    const disabled = { ...config("/tmp/akm-team-disabled", false), scheduler: { enabled: [activation] } };
    expect(isSchedulerRefEnabled(disabled, "task", activation.ref)).toBe(false);
    expect(revokeSchedulerActivationsForBundle(disabled, "team").scheduler?.enabled).toEqual([]);
  });
});
