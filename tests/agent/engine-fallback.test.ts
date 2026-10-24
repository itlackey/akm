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
const opencodePresent = (bin: string) => (bin === "opencode" ? "/usr/local/bin/opencode" : undefined);
const nothingInstalled = () => undefined;

describe("withEngineFallback", () => {
  test("a configured defaults.engine is returned untouched, and the object identity is preserved", () => {
    const config = { ...base, defaults: { engine: "claude" } } as AkmConfig;
    const result = withEngineFallback(config, opencodePresent);
    // Identity, not just equality: callers use it to detect the common case.
    expect(result.config).toBe(config);
    expect(result.fallbackEngineName).toBeUndefined();
  });

  test("no engine + opencode on PATH synthesizes a config-free opencode-sdk engine", () => {
    const result = withEngineFallback(base, opencodePresent);
    expect(result.config.defaults?.engine).toBe(FALLBACK_ENGINE_NAME);
    const engine = result.config.engines?.[FALLBACK_ENGINE_NAME];
    expect(engine).toEqual({ kind: "agent", platform: "opencode-sdk" });
    // Config-free is the whole point: no model/endpoint/credential means
    // buildSdkConfig() emits `{}` and opencode uses its OWN configuration.
    expect(Object.keys(engine as object).sort()).toEqual(["kind", "platform"]);
    expect(result.fallbackEngineName).toBe(FALLBACK_ENGINE_NAME);
  });

  test("no engine and no opencode leaves the config alone so the caller fails closed", () => {
    const result = withEngineFallback(base, nothingInstalled);
    expect(result.config).toBe(base);
    expect(result.config.defaults?.engine).toBeUndefined();
    expect(result.fallbackEngineName).toBeUndefined();
  });

  test("an operator-configured opencode-sdk engine wins over synthesizing one", () => {
    const configured = { kind: "agent", platform: "opencode-sdk", model: "sonnet", bin: "/opt/opencode" } as const;
    const config = { ...base, engines: { [FALLBACK_ENGINE_NAME]: configured } } as unknown as AkmConfig;
    // The probe follows the configured `bin`, so the stub must resolve it —
    // the custom-bin path itself is covered by its own test below.
    const result = withEngineFallback(config, (bin) => (bin === "/opt/opencode" ? bin : undefined));
    expect(result.config.engines?.[FALLBACK_ENGINE_NAME]).toBe(configured);
    expect(result.config.defaults?.engine).toBe(FALLBACK_ENGINE_NAME);
  });

  test("the input config is never mutated", () => {
    const config = { ...base, engines: { claude: { kind: "agent", platform: "claude" } } } as unknown as AkmConfig;
    const snapshot = JSON.stringify(config);
    withEngineFallback(config, opencodePresent);
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  test("existing engines survive alongside the synthesized one", () => {
    const config = { ...base, engines: { claude: { kind: "agent", platform: "claude" } } } as unknown as AkmConfig;
    const result = withEngineFallback(config, opencodePresent);
    expect(Object.keys(result.config.engines ?? {}).sort()).toEqual(["claude", FALLBACK_ENGINE_NAME].sort());
  });

  test("a configured fallback engine with a custom bin outside PATH is still probed (review P2)", () => {
    // The operator pinned an absolute bin; a bare `which opencode` says no.
    // Reporting the install as engine-less would contradict operator-wins.
    const onlyCustomBin = (bin: string) => (bin === "/opt/oc/bin/opencode" ? bin : undefined);
    const configured = { kind: "agent", platform: "opencode-sdk", bin: "/opt/oc/bin/opencode" } as const;
    const config = { ...base, engines: { [FALLBACK_ENGINE_NAME]: configured } } as unknown as AkmConfig;
    const result = withEngineFallback(config, onlyCustomBin);
    expect(result.fallbackEngineName).toBe(FALLBACK_ENGINE_NAME);
    expect(result.config.engines?.[FALLBACK_ENGINE_NAME]).toBe(configured);
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
