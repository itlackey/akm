// Output text formatters for `akm vault *` commands.

import { formatVaultCreatePlain, formatVaultListPlain, formatVaultSetPlain, formatVaultUnsetPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("vault-list", (r) => formatVaultListPlain(r));
registerTextFormatter("vault-create", (r) => formatVaultCreatePlain(r));
registerTextFormatter("vault-set", (r) => formatVaultSetPlain(r));
registerTextFormatter("vault-unset", (r) => formatVaultUnsetPlain(r));
