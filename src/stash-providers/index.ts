/**
 * Centralized stash provider registration.
 *
 * Import this module (side-effect import) to register all built-in stash
 * providers with the provider registry. This replaces the individual
 * side-effect imports that were duplicated in stash-search.ts and stash-show.ts.
 */
import "./filesystem";
import "./openviking";
