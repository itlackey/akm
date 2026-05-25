import { formatListPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("list", (r) => formatListPlain(r));
