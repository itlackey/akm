import { formatFeedbackPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("feedback", (r) => formatFeedbackPlain(r));
