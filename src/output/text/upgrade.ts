import { formatUpgradePlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("upgrade", (r) => formatUpgradePlain(r));
