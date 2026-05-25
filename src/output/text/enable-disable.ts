import { formatToggleComponentPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("enable", (r) => formatToggleComponentPlain("enable", r));
registerTextFormatter("disable", (r) => formatToggleComponentPlain("disable", r));
