import { formatClonePlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("clone", (r) => formatClonePlain(r));
