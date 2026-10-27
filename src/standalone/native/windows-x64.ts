// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The ONNX Runtime library the win32 x64 onnxruntime-node addon links, embedded in the standalone binary. */
import library from "../../../node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll" with {
  type: "file",
};

export const embeddedPath: string | undefined = library;
export const fileName: string | undefined = "onnxruntime.dll";
