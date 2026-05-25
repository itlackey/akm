import { formatIndexPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("index", (r) => formatIndexPlain(r));
