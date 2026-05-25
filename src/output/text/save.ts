import { formatSavePlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("save", (r) => formatSavePlain(r));
