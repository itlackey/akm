// Output text formatters for `akm registry *` commands.

import {
  formatRegistryAddPlain,
  formatRegistryBuildIndexPlain,
  formatRegistryListPlain,
  formatRegistryRemovePlain,
  formatRegistrySearchPlain,
} from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("registry-list", (r) => formatRegistryListPlain(r));
registerTextFormatter("registry-add", (r) => formatRegistryAddPlain(r));
registerTextFormatter("registry-remove", (r) => formatRegistryRemovePlain(r));
registerTextFormatter("registry-search", (r, detail) => formatRegistrySearchPlain(r, detail));
registerTextFormatter("registry-build-index", (r) => formatRegistryBuildIndexPlain(r));
