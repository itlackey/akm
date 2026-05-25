import { formatAddPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("add", (r) => formatAddPlain(r));
