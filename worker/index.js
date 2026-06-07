/**
 * BananaByte — Cloudflare Worker
 *
 * The site is a static Astro build served from ./dist via Workers Static Assets.
 * `run_worker_first = ["/api/*"]` (see wrangler.toml) means ONLY /api/* requests
 * invoke this script; every other request is served straight from ./dist (fast,
 * free, uncounted). This Worker exists for one dynamic endpoint:
 *
 *   POST /api/contact  — validates a contact-form submission and notifies the
 *                        owner via (1) Telegram instant ping and (2) Resend email.
 *
 * Notifications are best-effort and independent: if either channel succeeds the
 * submission is accepted. Secrets (RESEND_API_KEY, TELEGRAM_BOT_TOKEN) are set via
 * `wrangler secret put` and never committed. Non-secret config lives in [vars].
 */

const MAX_BODY_BYTES = 16 * 1024; // 16 KB hard cap
const LIMITS = { name: 120, email: 254, phone: 40, message: 6000 };
// Pragmatic email check: exactly one @, no whitespace, a dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/* ----------------------------- helpers ----------------------------- */

// Strip CR/LF + control chars, collapse whitespace, trim, length-cap.
// Core anti-header-injection guard for anything that touches email headers.
function sanitize(value, maxLen) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

// Reject (don't clean) header-bound fields that contain CR/LF/controls.
function hasHeaderInjection(value) {
  return typeof value === "string" && /[\x00-\x1f\x7f]/.test(value);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    },
  });
}

/* --------------------------- notify channels --------------------------- */

// Telegram instant ping. Returns true on success. Best-effort.
async function notifyTelegram(env, fields) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const text =
    "\u{1F34C} New bananabyte.io inquiry\n\n" +
    `\u{1F464} ${fields.name}\n` +
    `\u{2709}\u{FE0F} ${fields.email}\n` +
    (fields.phone ? `\u{1F4F1} ${fields.phone}\n` : "") +
    `\n${fields.message}`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      disable_web_page_preview: true,
    }),
  });
  return res.ok;
}

// Resend transactional email (raw HTTPS API — no npm dependency).
// Returns true on success. Best-effort. NOTE: raw API field is snake_case `reply_to`.
async function notifyResend(env, fields) {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM; // must be on the Resend-verified bananabyte.io
  // MAIL_TO may be a comma-separated list of recipients (business inbox + personal).
  const to = String(env.MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Skip cleanly if unconfigured or the key is obviously malformed.
  if (!key || !key.startsWith("re_") || !from || to.length === 0) return false;

  const subject = `New inquiry from ${fields.name}`.slice(0, 180);
  const text =
    `Name:  ${fields.name}\n` +
    `Email: ${fields.email}\n` +
    `Phone: ${fields.phone || "(none)"}\n\n` +
    `${fields.message}\n`;
  const html =
    `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111">` +
    `<p style="margin:0 0 6px"><strong>Name:</strong> ${escapeHtml(fields.name)}</p>` +
    `<p style="margin:0 0 6px"><strong>Email:</strong> ${escapeHtml(fields.email)}</p>` +
    `<p style="margin:0 0 6px"><strong>Phone:</strong> ${escapeHtml(fields.phone || "(none)")}</p>` +
    `<hr style="border:none;border-top:1px solid #eee;margin:12px 0">` +
    `<p style="margin:0;white-space:pre-wrap">${escapeHtml(fields.message)}</p>` +
    `</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      reply_to: fields.email, // visitor's address — hit Reply to answer them
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) {
    // Log server-side; never leak provider detail to the client.
    console.error("Resend send failed", res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

// Cloudflare Turnstile (bot challenge) verification. Returns true if the token
// is valid — or if Turnstile isn't configured, so the form never hard-locks.
// Fails CLOSED (false) on an explicit failure or verify error when configured.
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // not configured → skip
  if (!token || typeof token !== "string") return false;
  const body = new URLSearchParams();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const out = await res.json();
    return out.success === true;
  } catch (e) {
    console.error("turnstile verify error", e?.message || e);
    return false;
  }
}

/* ------------------------------- handler ------------------------------- */

async function handleContact(request, env, origin) {
  // Size pre-check (Content-Length can lie; we re-check after read).
  const declaredLen = Number(request.headers.get("Content-Length") || "0");
  if (declaredLen > MAX_BODY_BYTES) {
    return json({ ok: false, success: false, error: "Payload too large" }, 413, origin);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Rate limit — keyed on the real client IP (CF-Connecting-IP is trustworthy here).
  if (env.CONTACT_LIMITER) {
    try {
      const { success } = await env.CONTACT_LIMITER.limit({ key: ip });
      if (!success) {
        return json({ ok: false, success: false, error: "Too many requests" }, 429, origin);
      }
    } catch (e) {
      console.error("rate limiter error", e?.message || e);
    }
  }

  // Read with a real byte cap.
  let raw;
  try {
    raw = await request.text();
  } catch {
    return json({ ok: false, success: false, error: "Bad request" }, 400, origin);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return json({ ok: false, success: false, error: "Payload too large" }, 413, origin);
  }

  // Parse JSON or urlencoded.
  let data = {};
  const ct = request.headers.get("Content-Type") || "";
  try {
    if (ct.includes("application/json")) {
      data = JSON.parse(raw);
    } else {
      data = Object.fromEntries(new URLSearchParams(raw));
    }
  } catch {
    return json({ ok: false, success: false, error: "Bad request" }, 400, origin);
  }
  if (typeof data !== "object" || data === null) {
    return json({ ok: false, success: false, error: "Bad request" }, 400, origin);
  }

  // Honeypot — the form's hidden `botcheck` checkbox. An unchecked checkbox is
  // omitted from the body entirely, so a real user never sends this field at all.
  // ANY presence (even "" or "on") means a bot filled it: silent 200, no notify.
  if ("botcheck" in data) {
    return json({ ok: true, success: true }, 200, origin);
  }

  // Validate required fields.
  const nameRaw = String(data.name ?? "");
  const emailRaw = String(data.email ?? "");
  const phoneRaw = String(data.phone ?? "");
  const messageRaw = String(data.message ?? "");

  if (!nameRaw.trim() || !emailRaw.trim() || !messageRaw.trim()) {
    return json({ ok: false, success: false, error: "Missing required fields" }, 400, origin);
  }
  // name + email feed the subject/reply_to header — hard-reject CRLF injection.
  if (hasHeaderInjection(nameRaw) || hasHeaderInjection(emailRaw)) {
    return json({ ok: false, success: false, error: "Invalid input" }, 400, origin);
  }

  const email = sanitize(emailRaw, LIMITS.email).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, success: false, error: "Invalid email" }, 400, origin);
  }

  const fields = {
    name: sanitize(nameRaw, LIMITS.name),
    email,
    phone: sanitize(phoneRaw, LIMITS.phone),
    // Keep newlines (\n \r) in the message body; strip other control chars.
    message: messageRaw
      .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .slice(0, LIMITS.message)
      .trim(),
  };

  // Bot challenge — verify the Turnstile token before doing any work that sends
  // mail/pings. Enforced only when TURNSTILE_SECRET is configured (else skipped).
  const tsToken = data["cf-turnstile-response"];
  if (!(await verifyTurnstile(env, tsToken, ip))) {
    return json({ ok: false, success: false, error: "Verification failed" }, 403, origin);
  }

  // Fire both channels; accept the submission if EITHER succeeds.
  const [tg, mail] = await Promise.all([
    notifyTelegram(env, fields).catch((e) => {
      console.error("telegram error", e?.message || e);
      return false;
    }),
    notifyResend(env, fields).catch((e) => {
      console.error("resend error", e?.message || e);
      return false;
    }),
  ]);

  if (!tg && !mail) {
    return json({ ok: false, success: false, error: "Could not send message" }, 502, origin);
  }
  return json({ ok: true, success: true }, 200, origin);
}

/* ----------------------- /api/event (cookieless click analytics) ----------------------- */

// Allowlisted event names — keeps the public counter from being polluted.
const EVENT_NAMES = new Set([
  "text_click", "whatsapp_click", "call_click", "email_click",
  "form_submit", "quote_click", "spin",
  "mode_business", "mode_performer",
  "theme_crazy", "theme_formal", "lang_es", "lang_en",
]);

// Beacon endpoint: increments a per-day counter blob in KV. Always 204 (fire-and-forget);
// never leaks why it ignored something, so it can't be probed.
async function handleEvent(request, env, allowed) {
  const ok204 = () => new Response(null, { status: 204 });
  if (request.method !== "POST") return ok204();

  const reqOrigin = request.headers.get("Origin");
  if (reqOrigin !== null && reqOrigin !== allowed) return ok204(); // cross-site -> ignore

  if (env.EVENT_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    try {
      const { success } = await env.EVENT_LIMITER.limit({ key: ip });
      if (!success) return ok204();
    } catch (e) { /* fail open — analytics is non-critical */ }
  }

  let name = "";
  try { name = String((JSON.parse(await request.text()) || {}).name || ""); }
  catch { return ok204(); }
  if (!EVENT_NAMES.has(name) || !env.EVENTS) return ok204();

  const day = new Date().toISOString().slice(0, 10);
  const key = "stats:" + day;
  try {
    const cur = (await env.EVENTS.get(key, "json")) || {};
    cur[name] = (cur[name] || 0) + 1;
    await env.EVENTS.put(key, JSON.stringify(cur), { expirationTtl: 60 * 60 * 24 * 100 });
  } catch (e) { console.error("event kv error", e?.message || e); }
  return ok204();
}

/* ----------------------- /api/stats (private dashboard, token-gated) ----------------------- */

async function handleStats(request, env, url) {
  const token = url.searchParams.get("token") || "";
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return new Response("Not found", { status: 404 }); // don't reveal the endpoint exists
  }
  if (!env.EVENTS) return new Response("No data store", { status: 500 });

  const list = await env.EVENTS.list({ prefix: "stats:" });
  const days = [];
  const totals = {};
  for (const k of list.keys) {
    const counts = (await env.EVENTS.get(k.name, "json")) || {};
    days.push({ day: k.name.slice(6), counts });
    for (const [n, v] of Object.entries(counts)) totals[n] = (totals[n] || 0) + v;
  }
  days.sort((a, b) => (a.day < b.day ? 1 : -1)); // newest first

  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify({ totals, days }, null, 2),
      { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const tRows = Object.keys(totals).sort().map((n) => `<tr><td>${esc(n)}</td><td class="n">${totals[n]}</td></tr>`).join("");
  const dRows = days.map((d) => {
    const r = Object.keys(d.counts).sort().map((n) => `<tr><td>${esc(n)}</td><td class="n">${d.counts[n]}</td></tr>`).join("");
    return `<h3>${esc(d.day)}</h3><table>${r}</table>`;
  }).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>BANANAbyte — event stats</title>
<style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0B0B0C;color:#E9E9EA;margin:0;padding:28px;max-width:640px}h1{font-size:20px}h1 b{color:#F5C800}h2{margin-top:28px;font-size:13px;color:#8a8a8f;text-transform:uppercase;letter-spacing:.08em}h3{margin:18px 0 6px;font-size:13px;color:#8a8a8f}table{width:100%;border-collapse:collapse;margin:0 0 8px}td{padding:7px 10px;border-bottom:1px solid #1f1f22}td.n{text-align:right;font-variant-numeric:tabular-nums;color:#F5C800;font-weight:700;width:84px}.m{color:#8a8a8f}</style></head>
<body><h1><b>BANANA</b>byte — click analytics</h1><p class="m">Cookieless · first-party · ${days.length} day(s) recorded.</p>
<h2>All-time totals</h2><table>${tRows || '<tr><td class="m">No events yet</td></tr>'}</table>
<h2>By day</h2>${dRows || '<p class="m">No events yet.</p>'}</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });
}

/* --------------------------------- entry --------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ALLOWED = env.ALLOWED_ORIGIN || "https://bananabyte.io";
    // CORS header is always pinned to our own origin (never reflect arbitrary).
    const corsOrigin = ALLOWED;

    if (url.pathname === "/api/contact") {
      if (request.method === "OPTIONS") {
        // 204 must NOT carry a body — return a bodyless preflight response.
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
            "Vary": "Origin",
          },
        });
      }
      if (request.method !== "POST") {
        return json({ ok: false, success: false, error: "Method not allowed" }, 405, corsOrigin);
      }
      // Same-origin enforcement (CSRF + scripted-abuse guard): a foreign Origin is
      // rejected outright; when Origin is absent we REQUIRE a valid same-origin
      // Referer, which blocks curl/script posts that send neither header. Real
      // browsers always send Origin on a POST, so legitimate users are unaffected.
      const reqOrigin = request.headers.get("Origin");
      const referer = request.headers.get("Referer") || "";
      const refererOk = referer === ALLOWED || referer.startsWith(ALLOWED + "/");
      if (reqOrigin !== null) {
        if (reqOrigin !== ALLOWED) {
          return json({ ok: false, success: false, error: "Forbidden" }, 403, corsOrigin);
        }
      } else if (!refererOk) {
        return json({ ok: false, success: false, error: "Forbidden" }, 403, corsOrigin);
      }
      return handleContact(request, env, corsOrigin);
    }

    if (url.pathname === "/api/event") {
      return handleEvent(request, env, ALLOWED);
    }
    if (url.pathname === "/api/stats") {
      return handleStats(request, env, url);
    }

    // Unknown /api/* path — explicit 404 (don't fall through to the 404 asset page).
    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Not found" }, 404, corsOrigin);
    }

    // Fall-through: serve the static site. (With run_worker_first scoped to
    // /api/*, non-API requests don't normally reach here, but this keeps the
    // handler correct if that scoping ever changes.)
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error("assets fetch failed", e?.message || e);
      return new Response("Service unavailable", { status: 502 });
    }
  },
};
