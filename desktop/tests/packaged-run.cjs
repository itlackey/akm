// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Loaded with `-r` by tests/electron.test.mjs. The unpackaged app answers `app.isPackaged` as an installed build does,
// which is how electron/main.mjs tells a development run from an installed one; nothing else changes.
const { app } = require("electron");

Object.defineProperty(app, "isPackaged", { get: () => true });
