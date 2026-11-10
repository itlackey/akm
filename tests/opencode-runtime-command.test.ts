// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";
import {
  akmOpencodeDatabasePath,
  akmRuntimeDir,
  databaseIn,
  opencodeCacheDir,
  opencodeConfigDir,
  opencodeDatabasePath,
} from "../src/integrations/harnesses/opencode/roots";
import {
  type RuntimeLocations,
  runtimeArgv,
  runtimeConfig,
  runtimeEnv,
  runtimePrepareArgv,
} from "../src/integrations/harnesses/opencode/runtime/command";
import {
  _setOpencodeVersionProbeForTests,
  detectOpencodeMajor,
  resolveOpencodeBin,
} from "../src/integrations/harnesses/opencode/version";
import type { ChatCompletionConfig } from "../src/llm/client";
import { withOpencodeOnPath } from "./_helpers/opencode-version";
import { makeSandboxDir, withEnv } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

/**
 * The OpenCode process akm's own runtime starts for one run (`runtime/command.ts`):
 * its inline config, its environment and its command line. The connection is the
 * only provider; akm's roots, the free-model and catalog switches and the plugin
 * are set.
 */

const PLUGIN = "/akm/data/opencode-runtime/config/akm-plugin";
const KEY_FILE = "/akm/data/opencode-runtime/keys/ses_akm1";

const connection = (extra: Partial<ChatCompletionConfig> = {}): ChatCompletionConfig => ({
  endpoint: "https://llm.example/v1/chat/completions",
  model: "org/model:7b",
  ...extra,
});

const where: RuntimeLocations = {
  binary: "/akm/cache/opencode/2.2.0/opencode",
  directory: "/akm/data/opencode-runtime",
  pluginDirectory: PLUGIN,
  akm: ["/usr/local/bin/node", "/usr/local/lib/node_modules/akm-cli/dist/akm"],
};

type Provider = {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey?: string };
  models: Record<string, { name: string; limit?: { context: number; output: number } }>;
};
const providerOf = (config: Record<string, unknown>): Provider => (config.provider as { akm: Provider }).akm;

describe("the inline config", () => {
  test("the connection is the only provider: the package OpenCode bundles, the endpoint's base URL, the one model", () => {
    const config = runtimeConfig(connection(), PLUGIN, KEY_FILE);

    expect(Object.keys(config.provider as object)).toEqual(["akm"]);
    expect(providerOf(config)).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "akm",
      options: { baseURL: "https://llm.example/v1" },
      models: { "org/model:7b": { name: "org/model:7b" } },
    });
  });

  test("the key is the provider's, read from the run's key file, and only when the connection has one", () => {
    const config = runtimeConfig(connection({ apiKey: "sk-secret" }), PLUGIN, KEY_FILE);

    expect(providerOf(config).options).toEqual({
      baseURL: "https://llm.example/v1",
      apiKey: `{file:${KEY_FILE}}`,
    });
    // The key itself is nowhere in the config, so it is in no process's environment.
    expect(JSON.stringify(config)).not.toContain("sk-secret");
    expect(providerOf(runtimeConfig(connection(), PLUGIN, KEY_FILE)).options).not.toHaveProperty("apiKey");
  });

  test.each([
    ["states neither", {}, undefined],
    ["states its window", { contextLength: 32_768 }, { context: 32_768, output: 32_000 }],
    ["states its output cap", { request: { max_tokens: 2_048 } }, { context: 200_000, output: 2_048 }],
    ["states both", { contextLength: 32_768, request: { max_tokens: 2_048 } }, { context: 32_768, output: 2_048 }],
    // OpenCode refuses a model whose limit states only one of the two, so the other is its own assumption.
  ] as const)("a connection that %s", (_name, extra, limit) => {
    const model = providerOf(runtimeConfig(connection(extra as Partial<ChatCompletionConfig>), PLUGIN, KEY_FILE))
      .models["org/model:7b"];
    expect(model?.limit).toEqual(limit);
  });

  test("the plugin is named with the connection's request fields in the endpoint's own names", () => {
    const config = runtimeConfig(
      connection({
        request: { top_p: 0.9, chat_template_kwargs: { thinking_budget: 100 } },
        inference: { temperature: 0.2, maxTokens: 4096, reasoningEffort: "high", enableThinking: false },
      }),
      PLUGIN,
      KEY_FILE,
    );

    expect(config.plugins).toEqual([
      {
        package: PLUGIN,
        options: {
          akm: [],
          shellEnv: expect.any(Object),
          requestFields: expect.objectContaining({
            top_p: 0.9,
            temperature: 0.2,
            max_tokens: 4096,
            reasoning_effort: "high",
            chat_template_kwargs: { thinking_budget: 100, enable_thinking: false },
          }),
        },
      },
    ]);
  });

  test("the fields akm owns are not the connection's to send", () => {
    const config = runtimeConfig(
      connection({ request: { model: "other", messages: [], stream: false } }),
      PLUGIN,
      KEY_FILE,
    );

    const [entry] = config.plugins as Array<{ options: { requestFields: Record<string, unknown> } }>;
    expect(entry?.options.requestFields).toEqual({});
  });

  test("it defines no agent: OpenCode's own default runs, with its normal tools", () => {
    expect(runtimeConfig(connection(), PLUGIN, KEY_FILE)).not.toHaveProperty("agents");
  });
});

describe("the environment", () => {
  const env = runtimeEnv(runtimeConfig(connection({ apiKey: "sk-secret" }), PLUGIN, KEY_FILE), where);

  test("OpenCode's roots and its temp directory are akm's, under the runtime directory", () => {
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: path.join(where.directory, "config"),
      XDG_DATA_HOME: path.join(where.directory, "data"),
      XDG_CACHE_HOME: path.join(where.directory, "cache"),
      XDG_STATE_HOME: path.join(where.directory, "state"),
      TMPDIR: path.join(where.directory, "tmp"),
    });
  });

  test("no hosted free models, no model catalog fetch, no project config, no Claude Code files", () => {
    expect(env).toMatchObject({
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    });
  });

  test("the plugin is told, for each variable the run sets, what the agent's commands get: akm's value, or none", () => {
    const config = runtimeConfig(connection(), PLUGIN, KEY_FILE, {
      XDG_DATA_HOME: "/home/me/.local/share",
      TMPDIR: "/tmp",
    });

    const [entry] = config.plugins as Array<{ options: { shellEnv: Record<string, string | null> } }>;
    const { shellEnv } = entry?.options ?? { shellEnv: {} };
    expect(shellEnv.XDG_DATA_HOME).toBe("/home/me/.local/share");
    expect(shellEnv.TMPDIR).toBe("/tmp");
    expect(shellEnv.XDG_CACHE_HOME).toBeNull();
    expect(shellEnv.OPENCODE_CONFIG_CONTENT).toBeNull();
    // Every variable runtimeEnv sets is covered.
    expect(Object.keys(shellEnv).sort()).toEqual(Object.keys(env).sort());
  });

  test("the config goes in OPENCODE_CONFIG_CONTENT, and the argv that runs akm, for the plugin, is its akm option", () => {
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)).toEqual(
      runtimeConfig(connection({ apiKey: "sk-secret" }), PLUGIN, KEY_FILE),
    );
    expect(env).not.toHaveProperty("AKM_OPENCODE_CLI");
    const config = runtimeConfig(connection(), PLUGIN, KEY_FILE, {}, where.akm);
    const [entry] = config.plugins as Array<{ options: { akm: string[] } }>;
    expect(entry?.options.akm).toEqual(["/usr/local/bin/node", "/usr/local/lib/node_modules/akm-cli/dist/akm"]);
  });
});

describe("the command line", () => {
  test("a standalone run named akm, in the session akm names, on the connection's model", () => {
    expect(runtimeArgv(connection(), { prompt: "p" }, where.binary, "ses_akm1")).toEqual([
      where.binary,
      "run",
      "--standalone",
      "--title",
      "akm",
      "--session",
      "ses_akm1",
      "--model",
      "akm/org/model:7b",
    ]);
  });

  test("a native agent the request names runs", () => {
    expect(runtimeArgv(connection(), { prompt: "p", agent: "plan" }, where.binary, "ses_akm1")).toContain("plan");
    expect(runtimeArgv(connection(), { prompt: "p", agent: "plan" }, where.binary, "ses_akm1").join(" ")).toContain(
      "--agent plan",
    );
  });

  test("the database is prepared by a command that runs no model and starts no background service", () => {
    expect(runtimePrepareArgv(where.binary)).toEqual([where.binary, "session", "list", "--standalone"]);
  });

  test("neither the prompt nor the key is on the command line", () => {
    const argv = runtimeArgv(
      connection({ apiKey: "sk-secret" }),
      { prompt: "a secret prompt" },
      where.binary,
      "ses_akm1",
    ).join(" ");

    expect(argv).not.toContain("sk-secret");
    expect(argv).not.toContain("a secret prompt");
  });
});

describe("OpenCode's roots", () => {
  test("follow the XDG base directories when they are set", () => {
    const env = { XDG_DATA_HOME: "/x/data", XDG_CACHE_HOME: "/x/cache", XDG_CONFIG_HOME: "/x/config", HOME: "/h" };
    expect(opencodeDatabasePath(env)).toBe(path.join("/x/data", "opencode", "opencode.db"));
    expect(opencodeCacheDir(env)).toBe(path.join("/x/cache", "opencode"));
    expect(opencodeConfigDir(env)).toBe(path.join("/x/config", "opencode"));
  });

  test("fall back to the XDG defaults under the home directory, on every platform", () => {
    const env = { HOME: "/h" };
    expect(opencodeDatabasePath(env)).toBe(path.join("/h", ".local", "share", "opencode", "opencode.db"));
    expect(opencodeCacheDir(env)).toBe(path.join("/h", ".cache", "opencode"));
    expect(opencodeConfigDir(env)).toBe(path.join("/h", ".config", "opencode"));
  });

  test("an empty XDG variable counts as unset", () => {
    expect(opencodeDatabasePath({ XDG_DATA_HOME: "  ", HOME: "/h" })).toBe(
      path.join("/h", ".local", "share", "opencode", "opencode.db"),
    );
  });

  test("OPENCODE_CONFIG_DIR moves the config directory, and an empty one counts as unset", () => {
    const env = { XDG_CONFIG_HOME: "/x/config", HOME: "/h" };
    expect(opencodeConfigDir({ ...env, OPENCODE_CONFIG_DIR: " /elsewhere " })).toBe("/elsewhere");
    expect(opencodeConfigDir({ ...env, OPENCODE_CONFIG_DIR: "  " })).toBe(path.join("/x/config", "opencode"));
  });

  test("the user's database and akm's are each one opencode.db, in the data directory they belong to", () => {
    expect(databaseIn("/somewhere")).toBe(path.join("/somewhere", "opencode.db"));
    expect(opencodeDatabasePath({ XDG_DATA_HOME: "/x/data", HOME: "/h" })).toBe(
      path.join("/x/data", "opencode", "opencode.db"),
    );
  });

  test("akm's runtime keeps everything under one directory of akm's data directory, and its database where OpenCode makes it", () => {
    expect(akmRuntimeDir()).toBe(path.join(getDataDir(), "opencode-runtime"));
    // The runtime's XDG_DATA_HOME is <runtime>/data, and OpenCode keeps opencode.db in an opencode folder of it.
    expect(akmOpencodeDatabasePath()).toBe(path.join(akmRuntimeDir(), "data", "opencode", "opencode.db"));
  });
});

describe("opencode-version-detection", () => {
  /**
   * Which OpenCode major an installed binary is: reading `--version`, choosing
   * the binary, the environment the probe gets, and the once-per-binary warning.
   * Fake binaries on PATH stand in for the program; the probe itself is real.
   */

  let warnings: string[];
  let probed: string[];

  /** Answer `--version` per binary path, and record which were asked. */
  function fakeBinaries(outputs: Record<string, string | undefined>): void {
    overrideSeam(_setOpencodeVersionProbeForTests, (bin) => {
      probed.push(bin);
      return outputs[bin];
    });
  }

  beforeEach(() => {
    warnings = [];
    probed = [];
    _resetWarnOnceForTests();
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
  });

  describe("the major in --version output", () => {
    const majorOf = (output: string): number | undefined => {
      fakeBinaries({ "fake-opencode": output });
      return detectOpencodeMajor("fake-opencode").reportedMajor;
    };

    test("reads both real output shapes", () => {
      expect(majorOf("1.18.34")).toBe(1);
      expect(majorOf("opencode v2.0.26")).toBe(2);
      expect(majorOf("opencode v3.1.0")).toBe(3);
    });

    test("is undefined when there is no version", () => {
      expect(majorOf("")).toBeUndefined();
      expect(majorOf("no version here")).toBeUndefined();
    });

    test("is undefined for another program's --version", () => {
      expect(majorOf("true (GNU coreutils) 9.7\nPackaged by Ubuntu (9.7-3ubuntu2.1)")).toBeUndefined();
    });
  });

  describe("resolveOpencodeBin", () => {
    test("prefers opencode2 when it is on PATH", async () => {
      await withOpencodeOnPath(2, async () => expect(resolveOpencodeBin()).toBe("opencode2"), {
        names: ["opencode", "opencode2"],
        exclusive: true,
      });
    });

    test("falls back to opencode when opencode2 is absent", async () => {
      await withOpencodeOnPath(2, async () => expect(resolveOpencodeBin()).toBe("opencode"), { exclusive: true });
    });
  });

  describe("detectOpencodeMajor", () => {
    test("OpenCode 1 warns once, naming version and path", async () => {
      await withOpencodeOnPath(1, async (dir) => {
        expect(detectOpencodeMajor("opencode")).toMatchObject({ reportedMajor: 1, version: "1.18.34" });
        detectOpencodeMajor("opencode");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("1.18.34");
        expect(warnings[0]).toContain(path.join(dir, "opencode"));
        expect(warnings[0]).toContain("OpenCode 1 support continues");
        expect(warnings[0]).toContain("upgrading to OpenCode 2 is recommended");
      });
    });

    test("OpenCode 2 is reported without a warning", async () => {
      await withOpencodeOnPath(2, async () => {
        expect(detectOpencodeMajor("opencode")).toMatchObject({ reportedMajor: 2, runnable: true });
        expect(warnings).toEqual([]);
      });
    });

    test("runs --version once per binary", async () => {
      await withOpencodeOnPath(
        2,
        async (dir) => {
          const [one, two] = [path.join(dir, "opencode"), path.join(dir, "opencode2")];
          fakeBinaries({ [one]: "opencode v2.0.26", [two]: "opencode v2.0.26" });
          for (let i = 0; i < 3; i++) detectOpencodeMajor("opencode");
          detectOpencodeMajor("opencode2");
          expect(probed).toEqual([one, two]);
        },
        { names: ["opencode", "opencode2"], exclusive: true },
      );
    });

    test("output that is not an OpenCode version reports no major", async () => {
      await withOpencodeOnPath(2, async (dir) => {
        fakeBinaries({ [path.join(dir, "opencode")]: "something odd" });
        expect(detectOpencodeMajor("opencode")).toEqual({ version: "something odd", runnable: true });
      });
    });

    test("a --version that fails is not runnable", async () => {
      await withOpencodeOnPath(
        "unreadable",
        async () => expect(detectOpencodeMajor("opencode")).toEqual({ version: "", runnable: false }),
        { exclusive: true },
      );
    });

    test("the probe gets the environment akm runs in", async () => {
      const bin = makeSandboxDir("akm-version-env");
      try {
        // Reports OpenCode 2 only when it sees a variable akm itself does not know of.
        fs.writeFileSync(
          path.join(bin.dir, "opencode"),
          `#!${process.execPath}\nconsole.log(process.env.AKM_PROBE_VAR === "synthetic" ? "opencode v2.0.26" : "not inherited");\n`,
          { mode: 0o755 },
        );
        await withEnv({ PATH: bin.dir, AKM_PROBE_VAR: "synthetic" }, async () => {
          _setOpencodeVersionProbeForTests(undefined);
          expect(detectOpencodeMajor("opencode")).toMatchObject({ reportedMajor: 2, version: "opencode v2.0.26" });
        });
      } finally {
        _setOpencodeVersionProbeForTests(undefined);
        bin.cleanup();
      }
    });
  });

  describe("the opencode harness's binary", () => {
    test("a harness with no bin runs opencode; one with a bin keeps it", () => {
      const config = {
        harnesses: {
          plain: { platform: "opencode" },
          pinned: { platform: "opencode", bin: "/opt/oc1/opencode" },
        },
      } as never;
      const plain = resolveTarget({ config, layers: [{ harness: "plain" }] });
      const pinned = resolveTarget({ config, layers: [{ harness: "pinned" }] });
      if (plain.kind !== "harness" || pinned.kind !== "harness") throw new Error("expected harness runners");
      expect(plain.bin).toBe("opencode");
      expect(pinned.bin).toBe("/opt/oc1/opencode");
    });
  });
});
