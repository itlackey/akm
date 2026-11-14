// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Two pages: the whole-library map (index.html) and the local graph around one asset (local.html).
export default {
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { index: "index.html", local: "local.html" } },
  },
};
