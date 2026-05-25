import { formatImportPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("import", (r) => formatImportPlain(r));
