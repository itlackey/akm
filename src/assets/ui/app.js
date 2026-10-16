// Placeholder client: shows the raw JSON of two API calls. The token arrives in
// the URL the CLI printed; it is kept in sessionStorage and sent as a header.
const params = new URLSearchParams(location.search);
let token = params.get("token");
try {
  if (token) sessionStorage.setItem("akm-ui-token", token);
  else token = sessionStorage.getItem("akm-ui-token");
} catch {
  // sessionStorage can be unavailable; the URL token still works for this load.
}
if (params.has("token")) history.replaceState(null, "", location.pathname);

async function api(path) {
  const response = await fetch(path, { headers: { "X-Akm-Ui-Token": token ?? "" } });
  return response.json();
}

async function show(id, path) {
  const target = document.getElementById(id);
  try {
    target.textContent = JSON.stringify(await api(path), null, 2);
  } catch (error) {
    target.textContent = String(error);
  }
}

show("meta", "/api/meta");
show("overview", "/api/overview");
