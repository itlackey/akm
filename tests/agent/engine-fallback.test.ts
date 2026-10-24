// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import {
  FALLBACK_ANNOUNCEMENT,
  FALLBACK_ENGINE_NAME,
  fallbackAnnouncement,
  withEngineFallback,
} from "../../src/integrations/agent/engine-fallback";

const base = { configVersion: "0.9.0" } as unknown as AkmConfig;

describe("withEngineFallback", () => {
  test("a configured defaults.engine is returned untouched, and the object identity is preserved", () => {
    const config = { ...base, defaults: { engine: "claude" } } as AkmConfig;
    const result = withEngineFallback(config);
    // Identity, not just equality: callers use it to detect the common case.
    expect(result.config).toBe(config);
    expect(result.fallbackEngineName).toBeUndefined();
  });

  test("no engine synthesizes a config-free opencode-sdk engine, with no binary needed", () => {
    const result = withEngineFallback(base);
    expect(result.config.defaults?.engine).toBe(FALLBACK_ENGINE_NAME);
    const engine = result.config.engines?.[FALLBACK_ENGINE_NAME];
    expect(engine).toEqual({ kind: "agent", platform: "opencode-sdk" });
    // Config-free is the whole point: no model/endpoint/credential means the
    // embedded OpenCode uses its OWN configuration.
    expect(Object.keys(engine as object).sort()).toEqual(["kind", "platform"]);
    expect(result.fallbackEngineName).toBe(FALLBACK_ENGINE_NAME);
  });

  test("an operator-configured opencode-sdk engine wins over synthesizing one", () => {
    const configured = { kind: "agent", platform: "opencode-sdk", model: "sonnet", bin: "/opt/opencode" } as const;
    const config = { ...base, engines: { [FALLBACK_ENGINE_NAME]: configured } } as unknown as AkmConfig;
    const result = withEngineFallback(config);
    expect(result.config.engines?.[FALLBACK_ENGINE_NAME]).toBe(configured);
    expect(result.config.defaults?.engine).toBe(FALLBACK_ENGINE_NAME);
  });

  test("the input config is never mutated", () => {
    const config = { ...base, engines: { claude: { kind: "agent", platform: "claude" } } } as unknown as AkmConfig;
    const snapshot = JSON.stringify(config);
    withEngineFallback(config);
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  test("existing engines survive alongside the synthesized one", () => {
    const config = { ...base, engines: { claude: { kind: "agent", platform: "claude" } } } as unknown as AkmConfig;
    const result = withEngineFallback(config);
    expect(Object.keys(result.config.engines ?? {}).sort()).toEqual(["claude", FALLBACK_ENGINE_NAME].sort());
  });
});

describe("fallbackAnnouncement", () => {
  test("announces only when the fallback candidate is the engine actually selected", () => {
    expect(fallbackAnnouncement(FALLBACK_ENGINE_NAME, FALLBACK_ENGINE_NAME)).toBe(FALLBACK_ANNOUNCEMENT);
  });

  test("stays silent when a higher-precedence engine won (review P2)", () => {
    // A prompt task's `engine:` and a workflow's document/unit `engine:` both
    // outrank `defaults.engine`. Announcing there would falsely claim opencode
    // supplied the provider/model/auth.
    expect(fallbackAnnouncement(FALLBACK_ENGINE_NAME, "reviewer")).toBeUndefined();
  });

  test("stays silent when no fallback was installed at all", () => {
    expect(fallbackAnnouncement(undefined, "claude")).toBeUndefined();
    expect(fallbackAnnouncement(undefined, undefined)).toBeUndefined();
  });
});
