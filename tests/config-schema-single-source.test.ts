import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config/config";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { type AkmConfigParsed, AkmConfigSchema } from "../src/core/config/config-schema";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

// The public `AkmConfig` type MUST BE the Zod schema's output type — no
// hand-written parallel interface. This guards against the two-source-of-truth
// drift that previously dropped nested keys (extract/timeoutMs/fullScan) at
// load: a new key added to the schema was silently absent from the interface,
// so a typed read couldn't see it and a load→save round trip wiped it.
//
// The type-equality assertions below fail to COMPILE (tsc --noEmit in
// check:fast) if `AkmConfig` and `z.output<typeof AkmConfigSchema>` ever
// diverge, and the runtime test proves the drop-prone nested keys survive a
// real load→save→load round trip through the typed surface.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// If AkmConfig ever stops being exactly the schema output, this line errors.
type _AkmConfigIsSchemaOutput = Expect<Equal<AkmConfig, AkmConfigParsed>>;

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  resetConfigCache();
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  resetConfigCache();
});

describe("AkmConfig derives from the Zod schema (single source of truth)", () => {
  test("previously drop-prone nested keys round-trip through a typed load→save→load", () => {
    // Built as a fully TYPED AkmConfig — no `as unknown as` escape hatch. If the
    // type didn't cover these nested keys (the old drift), this literal would
    // not compile.
    const config: AkmConfig = {
      semanticSearchMode: "off",
      profiles: {
        improve: {
          default: {
            processes: {
              graphExtraction: { fullScan: true, timeoutMs: 60000 },
              extract: { indexSessions: false, minNewSessions: 3 },
            },
          },
        },
      },
      improve: {
        calibration: { autoTune: true, maxThreshold: 80 },
      },
    };

    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();

    const graph = reloaded.profiles?.improve?.default?.processes?.graphExtraction;
    expect(graph?.fullScan).toBe(true);
    expect(graph?.timeoutMs).toBe(60000);

    const extract = reloaded.profiles?.improve?.default?.processes?.extract;
    expect(extract?.indexSessions).toBe(false);
    expect(extract?.minNewSessions).toBe(3);

    expect(reloaded.improve?.calibration?.autoTune).toBe(true);
    expect(reloaded.improve?.calibration?.maxThreshold).toBe(80);
  });

  test("the schema output type accepts the same typed value (parse round-trip)", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      profiles: { improve: { default: { processes: { graphExtraction: { fullScan: false } } } } },
    };
    const parsed = AkmConfigSchema.parse(config);
    expect(parsed.profiles?.improve?.default?.processes?.graphExtraction?.fullScan).toBe(false);
  });
});
