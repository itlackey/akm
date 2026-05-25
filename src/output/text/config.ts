import { formatConfigPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("config", (r) => formatConfigPlain(r));
