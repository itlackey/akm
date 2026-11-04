import { dispatch } from "../../../lib/server/http.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request, url }) => dispatch(request, url);
export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
export const PATCH = GET;
