// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Consolidated workspace activation-policy conformance (plan §11 Chunk 6.5).
 *
 * "Installation is not activation" (History D8): installing a bundle that
 * carries tasks, env files, and workflows grants NOTHING until the operator
 * explicitly activates them. Before Chunk 6.5 this enforcement was scattered
 * across four spots that each re-derived the rule; they now delegate to one
 * `core/activation-policy` module. These tests pin each ported decision at the
 * policy point and, together, prove the install-grants-nothing-until-enable
 * property the four call sites enforce. No new trust/approval machinery ships
 * (§1.3).
 */

import { describe, expect, test } from "bun:test";
import {
  decideDangerousEnvInjection,
  decideDangerousKeyInstall,
  isSourceWriteActivated,
  shouldSkipUnactivatedTask,
} from "../../src/core/activation-policy";

describe("activation-policy — rule 1: dangerous env-key injection", () => {
  test("no dangerous keys → allow (regardless of party)", () => {
    expect(decideDangerousEnvInjection({ dangerousKeys: [], thirdParty: true })).toBe("allow");
    expect(decideDangerousEnvInjection({ dangerousKeys: [], thirdParty: false })).toBe("allow");
  });

  test("third-party stash with a dangerous key → block (installation grants no injection)", () => {
    expect(decideDangerousEnvInjection({ dangerousKeys: ["LD_PRELOAD"], thirdParty: true })).toBe("block");
  });

  test("first-party stash with a dangerous key → warn but inject", () => {
    expect(decideDangerousEnvInjection({ dangerousKeys: ["EDITOR"], thirdParty: false })).toBe("warn");
  });
});

describe("activation-policy — rule 2: freshly-installed stash dangerous-key scan", () => {
  test("no findings → allow", () => {
    expect(decideDangerousKeyInstall({ findingsPresent: false, allowInsecure: false })).toBe("allow");
    expect(decideDangerousKeyInstall({ findingsPresent: false, allowInsecure: true })).toBe("allow");
  });

  test("findings present, no bypass → gate (install blocked pending confirm)", () => {
    expect(decideDangerousKeyInstall({ findingsPresent: true, allowInsecure: false })).toBe("gate");
  });

  test("findings present with --allow-insecure → warn-allow", () => {
    expect(decideDangerousKeyInstall({ findingsPresent: true, allowInsecure: true })).toBe("warn-allow");
  });
});

describe("activation-policy — rule 3: task activation gates scheduler fire-time", () => {
  test("a disabled task installed by a bundle is skipped when the scheduler fires it", () => {
    expect(shouldSkipUnactivatedTask({ enabled: false, scheduled: true })).toBe(true);
  });

  test("an enabled task fires", () => {
    expect(shouldSkipUnactivatedTask({ enabled: true, scheduled: true })).toBe(false);
  });

  test("a manual (non-scheduled) run dispatches even a disabled task (catch-up/testing)", () => {
    expect(shouldSkipUnactivatedTask({ enabled: false, scheduled: false })).toBe(false);
    expect(shouldSkipUnactivatedTask({ enabled: true, scheduled: false })).toBe(false);
  });
});

describe("activation-policy — rule 4: write activation (registry-cached is read-only)", () => {
  test("a source explicitly marked writable is write-activated", () => {
    expect(isSourceWriteActivated({ writable: true })).toBe(true);
  });

  test("a registry-cached source (no writable flag / writable:false) is read-only", () => {
    expect(isSourceWriteActivated({ writable: false })).toBe(false);
    expect(isSourceWriteActivated({})).toBe(false);
  });
});

describe("activation-policy — install grants nothing until an explicit enable", () => {
  test("a bundle carrying tasks/env/writes is inert on install across all four rules", () => {
    // A freshly-installed third-party bundle: env injection of a hijack key is
    // blocked, its dangerous-key install is gated, its bundled task will not
    // fire on schedule, and its cache is not writable — nothing is granted.
    expect(decideDangerousEnvInjection({ dangerousKeys: ["PATH"], thirdParty: true })).toBe("block");
    expect(decideDangerousKeyInstall({ findingsPresent: true, allowInsecure: false })).toBe("gate");
    expect(shouldSkipUnactivatedTask({ enabled: false, scheduled: true })).toBe(true);
    expect(isSourceWriteActivated({ writable: false })).toBe(false);

    // Only after an explicit enable does the task fire.
    expect(shouldSkipUnactivatedTask({ enabled: true, scheduled: true })).toBe(false);
  });
});
