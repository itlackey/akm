import { shapeShowOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("show", (result, detail, forAgent) =>
  shapeShowOutput(result as Record<string, unknown>, detail, forAgent),
);
