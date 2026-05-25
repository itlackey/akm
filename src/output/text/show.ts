import { formatShowPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("show", (r, detail) => formatShowPlain(r, detail));
