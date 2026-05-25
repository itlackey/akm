import { formatSearchPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("search", (r, detail) => formatSearchPlain(r, detail));
