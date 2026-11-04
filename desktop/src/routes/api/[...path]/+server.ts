import type { RequestHandler } from './$types';
import { dispatch } from '../../../lib/server/api.js';

export const GET: RequestHandler = ({ request, url }) => dispatch(request, url);
export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
export const PATCH = GET;
