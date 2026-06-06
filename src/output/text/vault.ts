// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm env *` (and the deprecated `akm vault *`) commands.

import {
  formatEnvCreatePlain,
  formatEnvExportPlain,
  formatEnvListPlain,
  formatEnvRemovePlain,
  formatEnvSetPlain,
  formatEnvUnsetPlain,
  formatVaultCreatePlain,
  formatVaultListPlain,
  formatVaultSetPlain,
  formatVaultUnsetPlain,
} from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("env-list", (r) => formatEnvListPlain(r));
registerTextFormatter("env-create", (r) => formatEnvCreatePlain(r));
registerTextFormatter("env-export", (r) => formatEnvExportPlain(r));
registerTextFormatter("env-remove", (r) => formatEnvRemovePlain(r));
registerTextFormatter("env-set", (r) => formatEnvSetPlain(r));
registerTextFormatter("env-unset", (r) => formatEnvUnsetPlain(r));

// Deprecated vault formatters — retained so any still-cached vault-shaped output
// renders; removed in 0.9.0 with the vault verb.
registerTextFormatter("vault-list", (r) => formatVaultListPlain(r));
registerTextFormatter("vault-create", (r) => formatVaultCreatePlain(r));
registerTextFormatter("vault-set", (r) => formatVaultSetPlain(r));
registerTextFormatter("vault-unset", (r) => formatVaultUnsetPlain(r));
