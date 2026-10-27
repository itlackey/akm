// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Targets onnxruntime-node ships no native library for (Intel macOS, musl Linux): nothing is embedded. */
export const embeddedPath: string | undefined = undefined;
export const fileName: string | undefined = undefined;
