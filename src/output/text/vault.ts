// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm vault *` commands.

import { formatVaultCreatePlain, formatVaultListPlain, formatVaultSetPlain, formatVaultUnsetPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("vault-list", (r) => formatVaultListPlain(r));
registerTextFormatter("vault-create", (r) => formatVaultCreatePlain(r));
registerTextFormatter("vault-set", (r) => formatVaultSetPlain(r));
registerTextFormatter("vault-unset", (r) => formatVaultUnsetPlain(r));
