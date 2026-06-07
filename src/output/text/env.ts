// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm env *` commands.

import {
  formatEnvCreatePlain,
  formatEnvExportPlain,
  formatEnvListPlain,
  formatEnvRemovePlain,
  formatEnvSetPlain,
  formatEnvUnsetPlain,
} from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("env-list", (r) => formatEnvListPlain(r));
registerTextFormatter("env-create", (r) => formatEnvCreatePlain(r));
registerTextFormatter("env-export", (r) => formatEnvExportPlain(r));
registerTextFormatter("env-remove", (r) => formatEnvRemovePlain(r));
registerTextFormatter("env-set", (r) => formatEnvSetPlain(r));
registerTextFormatter("env-unset", (r) => formatEnvUnsetPlain(r));
