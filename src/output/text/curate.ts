import { formatCuratePlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("curate", (r, detail) => formatCuratePlain(r, detail));
