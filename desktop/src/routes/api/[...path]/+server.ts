// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { dispatch } from "../../../lib/server/http.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request, url }) => dispatch(request, url);
export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
export const PATCH = GET;
