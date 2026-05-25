import { formatRemovePlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("remove", (r) => formatRemovePlain(r));
