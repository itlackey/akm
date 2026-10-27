// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The local embedder's runtime (`src/llm/embedders/onnx-runtime.ts`): on a platform
 * akm offers local embeddings on, the first load fetches onnxruntime-node's binding
 * and library into akm's cache from a registry tarball, checked against its
 * integrity, and a failed fetch says where from, where to and what to do. The
 * registry is a mocked fetch serving a tarball made with `tar`, so the binding in it
 * is not a real addon and the load after the fetch fails; the real binding is
 * loaded by tests/integration/semantic-search-e2e.test.ts and the standalone test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  hasLocalEmbeddings,
  loadOnnxRuntime,
  noLocalEmbeddingsReason,
  ONNXRUNTIME_VERSION,
} from "../src/llm/embedders/onnx-runtime";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  withMockedFetch,
} from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let scratch: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  scratch = makeSandboxDir("akm-onnx-runtime");
});

afterEach(() => {
  scratch.cleanup();
  storage.cleanup();
});

const LIBRARY = process.platform === "darwin" ? `libonnxruntime.${ONNXRUNTIME_VERSION}.dylib` : "libonnxruntime.so.1";

/** onnxruntime-node's tarball as far as akm reads it: this platform's binding and library, plus another platform's. */
function onnxTarball(): string {
  const root = path.join(scratch.dir, "pack");
  const here = path.join(root, "package", "bin", "napi-v6", process.platform, process.arch);
  const other = path.join(root, "package", "bin", "napi-v6", "win32", "x64");
  fs.mkdirSync(here, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(here, LIBRARY), "not a library");
  fs.writeFileSync(path.join(here, "onnxruntime_binding.node"), "not an addon");
  fs.writeFileSync(path.join(other, "onnxruntime.dll"), "another platform's");
  const archive = path.join(scratch.dir, "onnxruntime-node.tgz");
  const made = spawnSync("tar", ["-czf", archive, "-C", root, "package"], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`tar failed: ${made.stderr}`);
  return archive;
}

const integrityOf = (file: string): string =>
  `sha512-${createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;

/** A registry serving `archive` as onnxruntime-node@<version>; `requests` lists the URLs asked. */
function registry(archive: string, integrity = integrityOf(archive)) {
  const requests: string[] = [];
  const serve = (url: string): Response => {
    requests.push(url);
    if (url === `https://registry.npmjs.org/onnxruntime-node/${ONNXRUNTIME_VERSION}`) {
      return Response.json({ dist: { tarball: `${url}.tgz`, integrity } });
    }
    if (url.endsWith(".tgz")) return new Response(fs.readFileSync(archive));
    return new Response("not found", { status: 404 });
  };
  return { requests, serve };
}

const folder = (): string =>
  path.join(storage.root, "cache", "akm", "onnxruntime", `${ONNXRUNTIME_VERSION}-${process.platform}-${process.arch}`);

describe.skipIf(!hasLocalEmbeddings())("the local embedder's runtime, where akm offers local embeddings", () => {
  test("the first load fetches the binding and its library into the cache, and loads the binding from there", async () => {
    const { requests, serve } = registry(onnxTarball());

    // The fixture's binding is not an addon, so the load after the fetch fails, naming the cached file.
    await expect(withMockedFetch(() => loadOnnxRuntime(), serve)).rejects.toThrow(/onnxruntime_binding\.node/);

    expect(requests).toEqual([
      `https://registry.npmjs.org/onnxruntime-node/${ONNXRUNTIME_VERSION}`,
      `https://registry.npmjs.org/onnxruntime-node/${ONNXRUNTIME_VERSION}.tgz`,
    ]);
    expect(fs.readdirSync(folder()).sort()).toEqual([LIBRARY, "onnxruntime_binding.node"].sort());
    expect(fs.readFileSync(path.join(folder(), "onnxruntime_binding.node"), "utf8")).toBe("not an addon");
  });

  test("a binding already in the cache is loaded without a request", async () => {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), "onnxruntime_binding.node"), "not an addon");
    const { requests, serve } = registry(onnxTarball());

    await expect(withMockedFetch(() => loadOnnxRuntime(), serve)).rejects.toThrow(/onnxruntime_binding\.node/);

    expect(requests).toEqual([]);
  });

  test("a tarball that does not match the registry's integrity is refused before anything is kept", async () => {
    const { serve } = registry(onnxTarball(), `sha512-${Buffer.from("something else").toString("base64")}`);

    await expect(withMockedFetch(() => loadOnnxRuntime(), serve)).rejects.toThrow(/sha512 integrity is/);

    expect(fs.existsSync(folder()) ? fs.readdirSync(folder()) : []).toEqual([]);
  });

  test("a failed fetch names the package, its URL and the folder, and says how to get the files", async () => {
    let message = "";
    try {
      await withMockedFetch(
        () => loadOnnxRuntime(),
        () => new Response("gone", { status: 404 }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      `package onnxruntime-node from https://registry.npmjs.org/onnxruntime-node/${ONNXRUNTIME_VERSION} into ${folder()}`,
    );
    expect(message).toContain("HTTP 404");
    expect(message).toContain("akm setup --yes");
    expect(message).toContain(`bin/napi-v6/${process.platform}/${process.arch}/`);
  });
});

describe.skipIf(hasLocalEmbeddings())("the local embedder's runtime, everywhere else", () => {
  test("nothing is fetched, and the reason names the platform and the two choices", async () => {
    const { requests, serve } = registry(onnxTarball());

    await expect(withMockedFetch(() => loadOnnxRuntime(), serve)).rejects.toThrow(noLocalEmbeddingsReason());

    expect(requests).toEqual([]);
    expect(noLocalEmbeddingsReason()).toMatch(
      /^Local embeddings are not available on \S+; choose a remote endpoint or keyword search\.$/,
    );
  });
});
