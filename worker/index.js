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

/* ----------------------- /api/chat (bilingual AI front-desk demo) ----------------------- */

// Cheap, fast model — change here to swap the whole widget's brain.
const CHAT_MODEL = "google/gemini-2.5-flash";
const CHAT_MAX_BODY = 8 * 1024;     // 8 KB hard cap on the request body
const CHAT_MAX_TURNS = 16;          // accept at most this many prior messages
const CHAT_MAX_MSG_LEN = 2000;      // per-message content cap (chars)

// The front-desk persona. Facts are flat + closed: the model must NOT invent
// anything not listed and should redirect off-topic / unknown asks to Gabe.
const CHAT_SYSTEM = [
  "You are the BananaByte front-desk assistant — a friendly, lightly playful (banana brand) but professional helper on bananabyte.io.",
  "BananaByte is a SOLO Orlando web studio. Owner: Gabe, native bilingual (English/Spanish). He builds for BOTH local businesses AND entertainers/performers.",
  "",
  "SERVICES & FLAT PRICING (always quote 'from'):",
  "- One-page / Landing site — from $900",
  "- Local Business site — from $2,200",
  "- Online Store — from $2,500",
  "- Performer site — from $1,800",
  "- Redesign — from $1,500",
  "- Website Care (maintenance) — $99/mo",
  "- AI Front Desk (bilingual chatbot + missed-call text-back + reviews) — from $600 + $199/mo",
  "- Local SEO / Google Business — from $400 + $199/mo",
  "",
  "HOW IT WORKS: $300 to start, the rest as the work progresses. The client OWNS everything (code, domain, accounts). Typical turnaround ~2-3 weeks.",
  "REAL CLIENT: Peter Hefty — award-winning ventriloquist/comedian — peterheftyandjustin.com.",
  "CONTACT: the contact page, or text/call/WhatsApp (321) 202-3732, or email contact@bananabyte.io. Serves Orlando & Central Florida, plus remote.",
  "",
  "BEHAVIOR RULES:",
  "1. Reply CONCISELY: 2-4 sentences, no long lists unless asked.",
  "2. Reply in the SAME language the user writes (English or Spanish). Mirror their language each turn.",
  "3. ONLY discuss BananaByte and the visitor's potential web project. Politely redirect any off-topic question back to that.",
  "4. When the visitor shows interest, gently nudge them to start a project (point to 'Start a project' / the contact page, or texting Gabe at (321) 202-3732).",
  "5. NEVER invent facts, prices, timelines or services beyond what's listed above. If you don't know, say so and suggest contacting Gabe directly.",
].join("\n");

// One JSON-bodied chat turn against OpenRouter. On ANY upstream trouble we
// return null so the caller can serve a friendly fallback (never a hard error).
async function callOpenRouter(env, messages) {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        // OpenRouter's recommended attribution headers.
        "HTTP-Referer": "https://bananabyte.io",
        "X-Title": "BananaByte",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 256,
        temperature: 0.5,
        messages: [{ role: "system", content: CHAT_SYSTEM }, ...messages],
      }),
    });
    if (!res.ok) {
      console.error("openrouter http", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    return (typeof reply === "string" && reply.trim()) ? reply.trim() : null;
  } catch (e) {
    console.error("openrouter error", e?.message || e);
    return null;
  }
}

// Detect Spanish-leaning input so the FALLBACK reply matches the user's language
// even when the model never answered. Cheap heuristic on the last user message.
function looksSpanish(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const s = messages[i].content.toLowerCase();
      return /[áéíóúñ¿¡]|\b(hola|gracias|precio|cuánto|cuanto|cómo|como|necesito|quiero|página|pagina|tienda|cita|ayuda|sitio)\b/.test(s);
    }
  }
  return false;
}

async function handleChat(request, env, origin) {
  // Size pre-check (Content-Length can lie; we re-check after read).
  const declaredLen = Number(request.headers.get("Content-Length") || "0");
  if (declaredLen > CHAT_MAX_BODY) {
    return json({ ok: false, error: "Payload too large" }, 413, origin);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Tight per-IP rate limit — bounds OpenRouter credit spend.
  if (env.CHAT_LIMITER) {
    try {
      const { success } = await env.CHAT_LIMITER.limit({ key: ip });
      if (!success) {
        return json({
          ok: true,
          reply: "Whoa, lots of questions! 🍌 Give me a moment, then try again — or text Gabe at (321) 202-3732.",
        }, 429, origin);
      }
    } catch (e) {
      console.error("chat rate limiter error", e?.message || e);
    }
  }

  // Read with a real byte cap.
  let raw;
  try {
    raw = await request.text();
  } catch {
    return json({ ok: false, error: "Bad request" }, 400, origin);
  }
  if (raw.length > CHAT_MAX_BODY) {
    return json({ ok: false, error: "Payload too large" }, 413, origin);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Bad request" }, 400, origin);
  }
  if (typeof body !== "object" || body === null || !Array.isArray(body.messages)) {
    return json({ ok: false, error: "Bad request" }, 400, origin);
  }

  // Validate + normalize the conversation: small array of {role,content}.
  const rawMsgs = body.messages.slice(-CHAT_MAX_TURNS);
  const messages = [];
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.content !== "string") continue;
    const content = m.content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, CHAT_MAX_MSG_LEN);
    if (!content) continue;
    messages.push({ role: m.role, content });
  }
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return json({ ok: false, error: "No user message" }, 400, origin);
  }

  const reply = await callOpenRouter(env, messages);
  if (reply) {
    return json({ ok: true, reply }, 200, origin);
  }

  // Upstream hiccup — degrade gracefully (200) so the widget shows something useful.
  const fallback = looksSpanish(messages)
    ? "Uy, tuve un problemita conectándome. 🍌 Escríbele a Gabe al (321) 202-3732 o usa la página de contacto y te responde enseguida."
    : "Oops, I hit a snag connecting. 🍌 Text Gabe at (321) 202-3732 or use the contact page and he'll get right back to you.";
  return json({ ok: true, reply: fallback }, 200, origin);
}

/* ----------------------- /api/chat-log (transcript → owner email) ----------------------- */

// Fire-and-forget transcript logging. The widget beacons the finished
// conversation here when the visitor closes the panel or leaves the page; we
// turn it into a readable email (+ a short Telegram ping) for Gabe. ALWAYS
// returns 204 — this must never block the beacon or surface an error.
const LOG_MAX_BODY = 16 * 1024;   // 16 KB hard cap on the beacon body
const LOG_MAX_TURNS = 40;         // accept at most this many messages
const LOG_MAX_MSG_LEN = 2000;     // per-message content cap (chars)

// Track convoIds we've already emailed this isolate, so a close + an unload
// beacon (or a quick re-fire) can't double-send. Belt-and-suspenders alongside
// the widget's once-per-session 'logged' flag. Bounded so it can't grow forever.
const loggedConvos = new Set();
function rememberConvo(id) {
  if (!id) return;
  loggedConvos.add(id);
  if (loggedConvos.size > 500) {
    // Drop the oldest ~half (insertion order) to keep memory bounded.
    let drop = 250;
    for (const k of loggedConvos) { loggedConvos.delete(k); if (--drop <= 0) break; }
  }
}

// Resend email for a chat transcript. Mirrors notifyResend's raw-API pattern
// (no npm dep, same auth/headers) but ships the full conversation. Best-effort.
async function notifyResendChat(env, { subject, text, html }) {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  const to = String(env.MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!key || !key.startsWith("re_") || !from || to.length === 0) return false;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject: subject.slice(0, 180), text, html }),
  });
  if (!res.ok) {
    console.error("Resend chat-log send failed", res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

// Telegram instant ping for a chat transcript (short version). Best-effort.
async function notifyTelegramChat(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  return res.ok;
}

async function handleChatLog(request, env, origin) {
  // This endpoint NEVER blocks the beacon: every path returns 204.
  const ok204 = () => new Response(null, { status: 204 });

  // Size pre-check (Content-Length can lie; we re-check after read).
  const declaredLen = Number(request.headers.get("Content-Length") || "0");
  if (declaredLen > LOG_MAX_BODY) return ok204();

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Tight per-IP rate limit — guards Gabe's inbox against beacon floods.
  if (env.LOG_LIMITER) {
    try {
      const { success } = await env.LOG_LIMITER.limit({ key: ip });
      if (!success) return ok204();
    } catch (e) { /* fail open — logging is non-critical */ }
  }

  // Read with a real byte cap.
  let raw;
  try { raw = await request.text(); } catch { return ok204(); }
  if (raw.length > LOG_MAX_BODY) return ok204();

  let body;
  try { body = JSON.parse(raw); } catch { return ok204(); }
  if (typeof body !== "object" || body === null || !Array.isArray(body.messages)) return ok204();

  // De-dupe: if we've already emailed this convo from this isolate, drop it.
  const convoId = sanitize(String(body.convoId ?? ""), 64);
  if (convoId && loggedConvos.has(convoId)) return ok204();

  // Validate + normalize the transcript: {role:'user'|'assistant', content}.
  const rawMsgs = body.messages.slice(0, LOG_MAX_TURNS);
  const messages = [];
  let users = 0, assistants = 0;
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.content !== "string") continue;
    // Keep newlines in the body; strip other control chars; cap length.
    const content = m.content
      .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .trim()
      .slice(0, LOG_MAX_MSG_LEN);
    if (!content) continue;
    if (m.role === "user") users++; else assistants++;
    messages.push({ role: m.role, content });
  }

  // Skip trivial chats: require a REAL exchange (≥1 user AND ≥1 assistant).
  if (users < 1 || assistants < 1) return ok204();

  const lang = sanitize(String(body.lang ?? ""), 8) || "en";
  const page = sanitize(String(body.url ?? ""), 200) || "/";

  // Build the clean readable transcript: header line + "Visitor:" / "Assistant:".
  const headerText =
    `Chat from bananabyte.io — page ${page} · language ${lang} · ${messages.length} messages\n`;
  const turnsText = messages
    .map((m) => `${m.role === "user" ? "Visitor" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  const text = `${headerText}\n${turnsText}\n`;

  const html =
    `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111">` +
    `<p style="margin:0 0 4px;color:#555"><strong>Chat from bananabyte.io</strong></p>` +
    `<p style="margin:0 0 12px;color:#777">page ${escapeHtml(page)} · language ${escapeHtml(lang)} · ${messages.length} messages</p>` +
    `<hr style="border:none;border-top:1px solid #eee;margin:0 0 12px">` +
    messages.map((m) =>
      `<p style="margin:0 0 10px;white-space:pre-wrap">` +
      `<strong>${m.role === "user" ? "Visitor" : "Assistant"}:</strong> ${escapeHtml(m.content)}</p>`
    ).join("") +
    `</div>`;

  const subject = `\u{1F34C} BananaByte chat — ${messages.length} messages`;

  // Short Telegram version: header + first visitor line, truncated.
  const firstUser = messages.find((m) => m.role === "user");
  const tgText =
    `\u{1F34C} BananaByte chat (${messages.length} msgs · ${lang} · ${page})\n` +
    (firstUser ? `\u{1F4AC} ${firstUser.content.slice(0, 240)}` : "");

  // Mark logged BEFORE sending so an immediate retry can't double-fire while
  // the awaits are in flight.
  rememberConvo(convoId);

  // Best-effort, independent channels. Swallow everything — always 204.
  try {
    await Promise.all([
      notifyResendChat(env, { subject, text, html }).catch((e) => {
        console.error("chat-log resend error", e?.message || e);
        return false;
      }),
      notifyTelegramChat(env, tgText).catch((e) => {
        console.error("chat-log telegram error", e?.message || e);
        return false;
      }),
    ]);
  } catch (e) {
    console.error("chat-log notify error", e?.message || e);
  }

  return ok204();
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

    if (url.pathname === "/api/chat") {
      if (request.method === "OPTIONS") {
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
        return json({ ok: false, error: "Method not allowed" }, 405, corsOrigin);
      }
      // Same-origin enforcement, identical to /api/contact: reject a foreign
      // Origin; when Origin is absent require a same-origin Referer (blocks
      // curl/script posts with neither header). Real browsers always send Origin.
      const chatOrigin = request.headers.get("Origin");
      const chatReferer = request.headers.get("Referer") || "";
      const chatRefererOk = chatReferer === ALLOWED || chatReferer.startsWith(ALLOWED + "/");
      if (chatOrigin !== null) {
        if (chatOrigin !== ALLOWED) {
          return json({ ok: false, error: "Forbidden" }, 403, corsOrigin);
        }
      } else if (!chatRefererOk) {
        return json({ ok: false, error: "Forbidden" }, 403, corsOrigin);
      }
      return handleChat(request, env, corsOrigin);
    }

    if (url.pathname === "/api/chat-log") {
      if (request.method === "OPTIONS") {
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
      // POST-only. A wrong method is silently a no-op (204) — never error the beacon.
      if (request.method !== "POST") {
        return new Response(null, { status: 204 });
      }
      // Same-origin enforcement, identical to /api/contact + /api/chat: reject a
      // foreign Origin; when Origin is absent require a same-origin Referer.
      // sendBeacon always sends an Origin from a real browser, so legit
      // beacons are unaffected. Cross-site/script posts are dropped (204).
      const logOrigin = request.headers.get("Origin");
      const logReferer = request.headers.get("Referer") || "";
      const logRefererOk = logReferer === ALLOWED || logReferer.startsWith(ALLOWED + "/");
      if (logOrigin !== null) {
        if (logOrigin !== ALLOWED) return new Response(null, { status: 204 });
      } else if (!logRefererOk) {
        return new Response(null, { status: 204 });
      }
      return handleChatLog(request, env, corsOrigin);
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
