import { goto } from "$app/navigation";

/** Use Kit navigation so native Back/Forward participates in beforeNavigate.
 * Shallow history entries intentionally skip that lifecycle on popstate.
 */
export async function navigate(href: string, replace = false) {
  await goto(href, { state: {}, replace, reset: false });
}
