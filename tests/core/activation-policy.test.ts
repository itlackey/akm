// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workspace activation-policy conformance.
 *
 * "Installation is not activation": installing a bundle that carries tasks,
 * env files, and workflows grants NOTHING until the operator explicitly
 * activates them. The enforcement points delegate to one
 * `core/activation-policy` module. These tests pin each decision at the policy
 * point and, together, prove the install-grants-nothing-until-enable property
 * the call sites enforce.
 *
 * Task activation does not gate scheduler fire-time: task source v4 has no
 * document-level `enabled` to gate at fire time.
 */

import { describe, expect, test } from "bun:test";
import {
  decideDangerousEnvInjection,
  decideDangerousKeyInstall,
  isSourceWriteActivated,
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

  test("third-party stash whose ONLY findings are the interactive-tool group → warn, not block", () => {
    expect(decideDangerousEnvInjection({ dangerousKeys: ["EDITOR"], thirdParty: true })).toBe("warn");
    expect(decideDangerousEnvInjection({ dangerousKeys: ["VISUAL"], thirdParty: true })).toBe("warn");
    expect(decideDangerousEnvInjection({ dangerousKeys: ["PAGER"], thirdParty: true })).toBe("warn");
    expect(decideDangerousEnvInjection({ dangerousKeys: ["EDITOR", "PAGER"], thirdParty: true })).toBe("warn");
  });

  test("third-party stash mixing an interactive-tool key with a genuine RCE key → still block", () => {
    expect(decideDangerousEnvInjection({ dangerousKeys: ["EDITOR", "LD_PRELOAD"], thirdParty: true })).toBe("block");
  });

  test("--allow-dangerous-env-keys downgrades a third-party RCE-class block to warn", () => {
    expect(
      decideDangerousEnvInjection({
        dangerousKeys: ["LD_PRELOAD"],
        thirdParty: true,
        allowDangerousEnvKeys: true,
      }),
    ).toBe("warn");
  });

  test("the override is irrelevant to a first-party stash (already warn) or an allow-list", () => {
    expect(
      decideDangerousEnvInjection({ dangerousKeys: ["LD_PRELOAD"], thirdParty: false, allowDangerousEnvKeys: false }),
    ).toBe("warn");
    expect(decideDangerousEnvInjection({ dangerousKeys: [], thirdParty: true, allowDangerousEnvKeys: true })).toBe(
      "allow",
    );
  });
});

describe("activation-policy — rule 2: freshly-installed stash dangerous-key scan", () => {
  test("no findings → allow", () => {
    expect(decideDangerousKeyInstall({ findingsPresent: false, allowDangerousEnvKeys: false })).toBe("allow");
    expect(decideDangerousKeyInstall({ findingsPresent: false, allowDangerousEnvKeys: true })).toBe("allow");
  });

  test("findings present, no bypass → gate (install blocked pending confirm)", () => {
    expect(decideDangerousKeyInstall({ findingsPresent: true, allowDangerousEnvKeys: false })).toBe("gate");
  });

  test("findings present with --allow-dangerous-env-keys → warn-allow", () => {
    expect(decideDangerousKeyInstall({ findingsPresent: true, allowDangerousEnvKeys: true })).toBe("warn-allow");
  });
});

describe("activation-policy — rule 3: write activation (registry-cached is read-only)", () => {
  test("a source explicitly marked writable is write-activated", () => {
    expect(isSourceWriteActivated({ writable: true })).toBe(true);
  });

  test("a registry-cached source (no writable flag / writable:false) is read-only", () => {
    expect(isSourceWriteActivated({ writable: false })).toBe(false);
    expect(isSourceWriteActivated({})).toBe(false);
  });
});

describe("activation-policy — install grants nothing until an explicit enable", () => {
  test("a bundle carrying dangerous env keys and writes is inert on install across every remaining rule", () => {
    // A freshly-installed third-party bundle: env injection of a hijack key is
    // blocked, its dangerous-key install is gated, and its cache is not
    // writable — nothing is granted.
    expect(decideDangerousEnvInjection({ dangerousKeys: ["PATH"], thirdParty: true })).toBe("block");
    expect(decideDangerousKeyInstall({ findingsPresent: true, allowDangerousEnvKeys: false })).toBe("gate");
    expect(isSourceWriteActivated({ writable: false })).toBe(false);
  });
});
