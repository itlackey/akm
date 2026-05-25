import { formatInfoPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("info", (r) => formatInfoPlain(r));
