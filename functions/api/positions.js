// DEPRECATED — positions now come from positions.js in the repo (no API keys
// needed, priced live from the public option chain in the browser). This
// endpoint is kept only so any old client gets a clear message.
export async function onRequestGet() {
  return new Response(
    JSON.stringify({ error: "positions moved to positions.js (repo config)" }),
    { status: 410, headers: { "content-type": "application/json" } }
  );
}
