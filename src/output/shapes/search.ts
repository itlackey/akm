import { shapeSearchOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("search", (result, detail, forAgent) =>
  shapeSearchOutput(result as Record<string, unknown>, detail, forAgent),
);
