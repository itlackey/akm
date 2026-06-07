// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Characterization test for WS7 (#490): the `akm env *` plain-text formatters
// are registered as a side effect of importing the text-output barrel. This
// pins the registration set so the mechanical rename of the registering module
// (src/output/text/vault.ts -> src/output/text/env.ts) cannot silently drop a
// formatter. Asserting the exact set guards the rename's zero-behaviour-change
// contract.

import { describe, expect, it } from "bun:test";
// Importing the barrel triggers every `registerTextFormatter` side effect,
// including the env-* registrations in src/output/text/env.ts.
import "../src/output/text";
import { getTextFormatterHandler } from "../src/output/text/registry";

const ENV_COMMANDS = ["env-list", "env-create", "env-export", "env-remove", "env-set", "env-unset"] as const;

describe("env text formatters (WS7 rename guard)", () => {
  for (const command of ENV_COMMANDS) {
    it(`registers a plain-text formatter for "${command}"`, () => {
      expect(typeof getTextFormatterHandler(command)).toBe("function");
    });
  }
});
