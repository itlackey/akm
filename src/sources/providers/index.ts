// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Centralized source provider registration.
 *
 * Import this module (side-effect import) to register all built-in source
 * providers with the provider registry. This replaces the individual
 * side-effect imports that were duplicated in source-search.ts and source-show.ts.
 */
import "./filesystem";
import "./git";
import "./npm";
import "./website";
