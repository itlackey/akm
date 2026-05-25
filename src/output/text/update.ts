import { formatUpdatePlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("update", (r) => formatUpdatePlain(r));
