import { formatInitPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("init", (r) => formatInitPlain(r));
