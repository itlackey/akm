import { formatRememberPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("remember", (r) => formatRememberPlain(r));
