// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The ONNX Runtime library the darwin arm64 onnxruntime-node addon links, embedded in the standalone binary. */
import library from "../../../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.24.3.dylib" with {
  type: "file",
};

export const embeddedPath: string | undefined = library;
export const fileName: string | undefined = "libonnxruntime.1.24.3.dylib";
