// ── Site-wide password gate ───────────────────────────────────────────────
// Cloudflare Pages runs _middleware.js in front of every request to the
// project — static pages, assets, and /api/* functions alike — so this is
// the one place that can block the whole site behind a single password.
//
// Setup (one-time, in the Cloudflare dashboard — this file can't do it):
//   Pages project → Settings → Environment variables → add a secret named
//   SITE_PASSWORD (Production AND Preview) → redeploy.
// If SITE_PASSWORD is unset, the gate is a no-op (site behaves as before) —
// so it's safe to ship this file before you've set the secret.

const COOKIE_NAME = "site_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const LOGIN_PATH = "/__login";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loginPage(showError) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — BTC Strangle Monitor</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(1200px 500px at 75% -10%, rgba(96,165,250,.07), transparent 60%),
                radial-gradient(900px 420px at 10% -5%, rgba(240,180,41,.05), transparent 55%),
                linear-gradient(180deg, #0b0f19, #07090f 400px);
    color: #e8ecf4; font-family: -apple-system, "Inter", sans-serif; }
  form { background: rgba(255,255,255,.028); border: 1px solid rgba(255,255,255,.09); border-radius: 14px;
    padding: 32px 28px; width: 100%; max-width: 320px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
  h1 { font-size: 15px; font-weight: 800; letter-spacing: .4px; margin: 0 0 20px; display: flex; align-items: center; gap: 10px; }
  h1 .mark { width: 28px; height: 28px; border-radius: 8px;
    background: linear-gradient(135deg,#f0b429 0%,#f97316 100%); display: grid; place-items: center;
    font-size: 14px; flex-shrink: 0; }
  input { width: 100%; background: #0b0f19; border: 1px solid rgba(255,255,255,.12); border-radius: 9px;
    color: #e8ecf4; padding: 11px 12px; font-size: 14px; margin-bottom: 14px; font-family: inherit; }
  input:focus { outline: none; border-color: #f0b429; }
  button { width: 100%; background: linear-gradient(135deg,#f0b429 0%,#f97316 100%); border: none;
    border-radius: 9px; color: #0b0f19; font-weight: 700; padding: 11px; font-size: 14px; cursor: pointer; }
  button:hover { filter: brightness(1.05); }
  .err { color: #f87171; font-size: 12.5px; margin: -6px 0 14px; }
</style></head>
<body>
  <form method="POST" action="${LOGIN_PATH}">
    <h1><span class="mark">&#9889;</span> BTC Strangle Monitor</h1>
    ${showError ? `<div class="err">Wrong password — try again.</div>` : ""}
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Enter</button>
  </form>
</body></html>`;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const want = env.SITE_PASSWORD;

  // No password configured yet — don't lock anyone out by accident.
  if (!want) return next();

  const expected = await sha256Hex(want);
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const authed = match && match[1] === expected;

  if (url.pathname === LOGIN_PATH && request.method === "POST") {
    const form = await request.formData();
    const given = (form.get("password") || "").toString();
    if (given === want) {
      const headers = new Headers({ Location: "/" });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${expected}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
      );
      return new Response(null, { status: 302, headers });
    }
    return new Response(loginPage(true), { status: 401, headers: { "content-type": "text/html;charset=utf-8" } });
  }

  if (!authed) {
    return new Response(loginPage(false), { status: 401, headers: { "content-type": "text/html;charset=utf-8" } });
  }

  return next();
}
