/**
 * The local embedding model's files: fetched from the Hugging Face Hub on first
 * use into `<HF_HOME>/<repo>/<file>` (the layout earlier releases wrote), never
 * fetched again, and never fetched at all with HF_HUB_OFFLINE.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../../src/core/paths";
import { ensureLocalModelFiles } from "../../src/llm/embedders/local-model-files";
import {
  makeSandboxDir,
  type SandboxedDir,
  withEnv,
  withIsolatedAkmStorage,
  withMockedFetch,
} from "../_helpers/sandbox";

const MODEL = "Xenova/bge-small-en-v1.5";
const FILES = ["tokenizer.json", "tokenizer_config.json", "config.json", "onnx/model.onnx"];

let hfHome: SandboxedDir;
let storage: ReturnType<typeof withIsolatedAkmStorage>;

beforeEach(() => {
  hfHome = makeSandboxDir("akm-hf-home");
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  hfHome.cleanup();
});

/** Serve every file as its own path, recording which URLs were asked for. */
function serveFiles(requested: string[]): (url: string) => Response {
  return (url) => {
    requested.push(url);
    return new Response(`contents of ${url}`);
  };
}

describe("ensureLocalModelFiles", () => {
  test("fetches the four files from the Hub into HF_HOME/<repo>/ and returns that directory", async () => {
    const requested: string[] = [];

    const modelDir = await withEnv({ HF_HOME: hfHome.dir, HF_HUB_OFFLINE: undefined }, () =>
      withMockedFetch(() => ensureLocalModelFiles(MODEL), serveFiles(requested)),
    );

    expect(modelDir).toBe(path.join(hfHome.dir, "Xenova", "bge-small-en-v1.5"));
    expect(requested).toEqual(FILES.map((file) => `https://huggingface.co/${MODEL}/resolve/main/${file}`));
    for (const file of FILES) {
      expect(fs.readFileSync(path.join(modelDir, ...file.split("/")), "utf8")).toBe(
        `contents of https://huggingface.co/${MODEL}/resolve/main/${file}`,
      );
    }
    expect(fs.readdirSync(modelDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("uses <akm cache>/models when HF_HOME is not set", async () => {
    const modelDir = await withEnv({ HF_HOME: undefined, HF_HUB_OFFLINE: undefined }, () =>
      withMockedFetch(() => ensureLocalModelFiles(MODEL), serveFiles([])),
    );

    expect(modelDir).toBe(path.join(getCacheDir(), "models", "Xenova", "bge-small-en-v1.5"));
  });

  test("fetches nothing for a cache that is already complete", async () => {
    for (const file of FILES) {
      const target = path.join(hfHome.dir, MODEL, ...file.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "cached by an earlier release");
    }
    const requested: string[] = [];

    await withEnv({ HF_HOME: hfHome.dir, HF_HUB_OFFLINE: undefined }, () =>
      withMockedFetch(() => ensureLocalModelFiles(MODEL), serveFiles(requested)),
    );

    expect(requested).toEqual([]);
  });

  test("with HF_HUB_OFFLINE set, a missing file is an error naming it and nothing is fetched", async () => {
    const requested: string[] = [];

    const attempt = withEnv({ HF_HOME: hfHome.dir, HF_HUB_OFFLINE: "1" }, () =>
      withMockedFetch(() => ensureLocalModelFiles(MODEL), serveFiles(requested)),
    );

    await expect(attempt).rejects.toThrow(path.join(hfHome.dir, MODEL, "tokenizer.json"));
    expect(requested).toEqual([]);
  });

  test("a failed download leaves no file behind, so the next run fetches it again", async () => {
    const attempt = withEnv({ HF_HOME: hfHome.dir, HF_HUB_OFFLINE: undefined }, () =>
      withMockedFetch(
        () => ensureLocalModelFiles(MODEL),
        () => new Response("not found", { status: 404 }),
      ),
    );

    await expect(attempt).rejects.toThrow("HTTP 404");
    expect(fs.existsSync(path.join(hfHome.dir, MODEL, "tokenizer.json"))).toBe(false);
  });
});
