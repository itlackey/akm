// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * ONNX Runtime for the local embedder: onnxruntime-node's N-API binding and the
 * library it links, kept in akm's cache and loaded from there. `akm setup`
 * fetches them when local embeddings are chosen, and the first local embedding
 * fetches them when setup did not.
 *
 * akm does not depend on the onnxruntime-node package. Its JavaScript loads the
 * binding from a path inside the package, which a compiled standalone binary can
 * only satisfy by writing an embedded copy to the temp directory, and its install
 * script downloads CUDA providers akm never uses. Here the binding is loaded by
 * absolute path with the library beside it in the same folder, where the system
 * loader finds it (`$ORIGIN` on Linux, `@loader_path` on macOS).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { toErrorMessage } from "../../core/common";
import { fetchNpmPackageFiles, NPM_REGISTRY } from "../../core/npm-package";
import { getCacheDir } from "../../core/paths";
import { info } from "../../core/warn";

/**
 * The onnxruntime-node release whose binding akm loads, and the only one it supports. akm calls the binding through
 * the contract between that package's own JavaScript and its addon, which no release documents or promises and which
 * moves between releases (after 1.24.3, `loadModel` returns a promise and `initOrtOnce` takes a third argument). What
 * akm relies on: `initOrtOnce(logLevel, Tensor)`; `new InferenceSession()`; `loadModel(path, options)`;
 * `inputMetadata` and `outputMetadata` (`{ name }[]`); `run(feeds, fetches)`, which reads a tensor as
 * `{ type, data, dims, location }` and makes each result with `new Tensor(type, data, dims)`. To move it: change this
 * version, check that contract in the new release's `lib/binding.ts` and `lib/backend.ts`, check the library names in
 * {@link LIBRARIES}, and run the reference-vector test in `tests/integration/semantic-search-e2e.test.ts`, the gate for
 * any bump.
 */
export const ONNXRUNTIME_VERSION = "1.24.3";

/**
 * The platforms akm offers local embeddings on, each with the library the binding links there. Every other platform
 * has keyword search and remote embeddings. A platform is listed once a real run has verified it; Linux means glibc.
 */
const LIBRARIES: Readonly<Record<string, string>> = {
  "linux-x64": "libonnxruntime.so.1",
  "darwin-arm64": `libonnxruntime.${ONNXRUNTIME_VERSION}.dylib`,
};

const BINDING = "onnxruntime_binding.node";

/** This machine as `<platform>-<arch>`, Linux without glibc as `linux-musl-<arch>`. */
function thisPlatform(): string {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  const musl = process.platform === "linux" && !header?.glibcVersionRuntime;
  return `${process.platform}${musl ? "-musl" : ""}-${process.arch}`;
}

/** Whether akm offers local embeddings on this machine. */
export function hasLocalEmbeddings(): boolean {
  return thisPlatform() in LIBRARIES;
}

/** What a machine without local embeddings is told, wherever it is told. */
export function noLocalEmbeddingsReason(): string {
  return `Local embeddings are not available on ${thisPlatform()}; choose a remote endpoint or keyword search.`;
}

/** A tensor as the binding reads one and makes its results. */
export class OnnxTensor {
  readonly location = "cpu";
  constructor(
    readonly type: string,
    readonly data: BigInt64Array | Float32Array,
    readonly dims: readonly number[],
  ) {}
}

interface Binding {
  initOrtOnce(logLevel: number, tensor: typeof OnnxTensor): void;
  InferenceSession: new () => {
    loadModel(modelPath: string, options: object): void;
    readonly inputMetadata: ReadonlyArray<{ name: string }>;
    readonly outputMetadata: ReadonlyArray<{ name: string }>;
    run(feeds: Record<string, OnnxTensor>, fetches: Record<string, null>): Record<string, OnnxTensor>;
  };
}

/** A model loaded on the CPU. */
export interface OnnxSession {
  readonly inputNames: readonly string[];
  /** Every output of the model, by name, for `feeds` (the inputs it takes, by name). */
  run(feeds: Record<string, OnnxTensor>): Record<string, OnnxTensor>;
}

/** Fetch the binding and its library into `directory`, naming the package, its URL and the folder when it cannot. */
async function fetchOnnxRuntime(directory: string): Promise<string> {
  const library = LIBRARIES[thisPlatform()];
  if (!library) throw new Error(noLocalEmbeddingsReason());
  const source = `bin/napi-v6/${process.platform}/${process.arch}`;
  try {
    info(`Fetching ONNX Runtime ${ONNXRUNTIME_VERSION} for local embeddings (about 86 MB, once) into ${directory}.`);
    // The library first: a binding in the folder means its library is there too.
    await fetchNpmPackageFiles("onnxruntime-node", ONNXRUNTIME_VERSION, directory, [
      { member: `package/${source}/${library}`, file: library },
      { member: `package/${source}/${BINDING}`, file: BINDING },
    ]);
    return directory;
  } catch (error) {
    throw new Error(
      `Could not fetch ONNX Runtime ${ONNXRUNTIME_VERSION} for local embeddings: package onnxruntime-node from ${NPM_REGISTRY}/onnxruntime-node/${ONNXRUNTIME_VERSION} into ${directory}: ${toErrorMessage(error)}. ` +
        `Run \`akm setup --yes\` with network access, or copy ${BINDING} and ${library} from that package's ${source}/ into that folder.`,
    );
  }
}

/**
 * The binding, loaded and initialised from `<cache>/onnxruntime/<version>-<platform>-<arch>/`, where it and its library
 * are fetched first when the binding is not there.
 */
async function loadBinding(): Promise<Binding> {
  const directory = path.join(getCacheDir(), "onnxruntime", `${ONNXRUNTIME_VERSION}-${thisPlatform()}`);
  if (!fs.existsSync(path.join(directory, BINDING))) await fetchOnnxRuntime(directory);
  const loaded = createRequire(import.meta.url)(path.join(directory, BINDING)) as Binding;
  // 3: errors only.
  loaded.initOrtOnce(3, OnnxTensor);
  return loaded;
}

/** Once per process, however many callers ask meanwhile; a failure is not kept, so the next caller tries again. */
let loading: Promise<Binding> | undefined;

/** The runtime, ready to load models: fetched first when it is not in the cache, then loaded. */
export async function loadOnnxRuntime(): Promise<{ createSession(modelPath: string): OnnxSession }> {
  loading ??= loadBinding().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  const loaded = await loading;
  return {
    createSession(modelPath) {
      const session = new loaded.InferenceSession();
      session.loadModel(modelPath, { executionProviders: ["cpu"], logSeverityLevel: 3 });
      const outputs = Object.fromEntries(session.outputMetadata.map(({ name }) => [name, null]));
      return { inputNames: session.inputMetadata.map(({ name }) => name), run: (feeds) => session.run(feeds, outputs) };
    },
  };
}
