// Trench Scanner proxy Worker.
//
// Holds API keys as Worker secrets so the page never sees them:
//   TYPESAFE_API_KEY   - Jev (TypeSafe System One)       -> POST /jev
//   TWITTERAPI_IO_KEY  - optional X/Twitter layer         -> GET  /x
// Also offers a read-only relay for the public data APIs, used by the page only
// when a browser request to one of them fails (e.g. missing CORS)  -> /relay
//
// Endpoints
//   GET  /health        -> { ok, jev, x, questionsVersion }
//   GET  /jev/schema    -> question ids with their options/levels
//   POST /jev           -> { coins: [{ id, state }] }  (max 30)
//                          <- { results: { id: { answers } | { error } }, usage }
//   GET  /x?ca=&sym=&handle=
//   GET  /relay?u=<url>  |  POST /relay?u=<solana rpc url>  (allowlisted hosts)

import { QUESTIONS, QUESTIONS_VERSION, schema, questionsFor, CLAIM_QUESTIONS } from "./questions.js";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
const TW_BASE = "https://api.twitterapi.io";
const MAX_COINS = 12;
const MAX_STATE_BYTES = 16000;
const JEV_CONCURRENCY = 6;
const HOUR = 3600;

const RELAY_GET_HOSTS = new Set([
  "api.dexscreener.com",
  "api.geckoterminal.com",
  "api.rugcheck.xyz",
  "api.gopluslabs.io",
  "api-legacy.bubblemaps.io",
]);
const RELAY_POST_HOSTS = new Set(["api.mainnet-beta.solana.com", "solana-rpc.publicnode.com"]);
const RPC_METHODS = new Set(["getMultipleAccounts", "getAccountInfo"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env);
    const originOk = allowed.includes(origin);
    const cors = corsHeaders(originOk ? origin : allowed[0] || "*");

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Browser calls must come from an allowed page. (Not a hard security
    // boundary, since non-browser clients can fake Origin; it stops casual reuse.)
    if (url.pathname !== "/health" && !originOk) {
      return json({ error: "origin not allowed" }, 403, cors);
    }

    // Per-IP rate limit on the paid endpoints (Cloudflare rate-limit binding, see wrangler.toml).
    if ((url.pathname === "/jev" || url.pathname === "/jev/claim" || url.pathname === "/x") && env.LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.LIMITER.limit({ key: url.pathname + ":" + ip });
      if (!success) return json({ error: "rate limited by the Worker, wait a minute" }, 429, cors);
    }

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          jev: Boolean(env.TYPESAFE_API_KEY),
          x: Boolean(env.TWITTERAPI_IO_KEY),
          questionsVersion: QUESTIONS_VERSION,
        }, 200, cors);
      }
      if (url.pathname === "/jev/schema") return json(schema(), 200, cors);
      if (url.pathname === "/jev" && request.method === "POST") return await handleJev(request, env, ctx, cors);
      if (url.pathname === "/jev/claim" && request.method === "POST") return await handleClaim(request, env, ctx, cors);
      if (url.pathname === "/x" && request.method === "GET") return await handleX(url, env, ctx, cors);
      if (url.pathname === "/relay") return await handleRelay(request, url, ctx, cors);
      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, cors);
    }
  },
};

// ---------------------------------------------------------------- Jev

async function handleJev(request, env, ctx, cors) {
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503, cors);
  const body = await request.json().catch(() => null);
  const coins = body && Array.isArray(body.coins) ? body.coins.slice(0, MAX_COINS) : null;
  if (!coins || !coins.length) return json({ error: "expected { coins: [{ id, state }] }" }, 400, cors);

  const results = {};
  const usage = { input_tokens: 0, output_tokens: 0, cached: 0 };

  await pool(coins, JEV_CONCURRENCY, async (coin) => {
    const id = String(coin && coin.id || "");
    if (!id) return;
    const stateStr = JSON.stringify(coin.state ?? null);
    if (stateStr.length > MAX_STATE_BYTES) { results[id] = { error: "state too large" }; return; }

    const cacheKey = await cacheUrl("jev", QUESTIONS_VERSION + "|" + stateStr);
    const hit = await caches.default.match(cacheKey);
    if (hit) { results[id] = await hit.json(); usage.cached++; return; }

    const { questions, state } = questionsFor(coin.state);
    const res = await callJev(env.TYPESAFE_API_KEY, state, questions);
    if (res.error) { results[id] = { error: res.error }; return; }
    const out = { answers: normalizeAnswers(res.answers, questions), model: res.model };
    results[id] = out;
    usage.input_tokens += res.usage?.input_tokens || 0;
    usage.output_tokens += res.usage?.output_tokens || 0;
    ctx.waitUntil(caches.default.put(cacheKey, cacheable(out, HOUR)));
  });

  return json({ results, usage, questionsVersion: QUESTIONS_VERSION }, 200, cors);
}

// ---------------------------------------------------------------- yes/no claim check
// POST /jev/claim { claim, horizon, facts, yes: [..], no: [..] }
// Asks the fixed CLAIM_QUESTIONS twice, once with the YES case listed first and once with the NO
// case first, so the order the cases are presented in can be seen and averaged out.
async function handleClaim(request, env, ctx, cors) {
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503, cors);
  const b = await request.json().catch(() => null);
  const text = (x, n) => (typeof x === "string" ? x.trim().slice(0, n) : "");
  const list = (x) => (Array.isArray(x) ? x.map((a) => text(a, 500)).filter(Boolean).slice(0, 10) : []);
  const claim = text(b?.claim, 400), horizon = text(b?.horizon, 300), yes = list(b?.yes), no = list(b?.no);
  if (!claim || !horizon || !yes.length || !no.length) return json({ error: "expected { claim, horizon, facts, yes: [..], no: [..] }" }, 400, cors);
  const facts = b.facts ?? null;
  if (JSON.stringify(facts).length > 8000) return json({ error: "facts too large" }, 400, cors);

  const orders = [
    { order: "yes_first", state: { claim, horizon, facts, yesCase: yes, noCase: no } },
    { order: "no_first", state: { claim, horizon, facts, noCase: no, yesCase: yes } },
  ];
  const runs = await Promise.all(orders.map(async ({ order, state }) => {
    const res = await callJev(env.TYPESAFE_API_KEY, state, CLAIM_QUESTIONS);
    return res.error ? { order, error: res.error } : { order, answers: normalizeAnswers(res.answers, CLAIM_QUESTIONS), usage: res.usage };
  }));
  const good = runs.filter((r) => r.answers);
  if (!good.length) return json({ error: runs[0].error || "jev failed", runs }, 502, cors);
  const avg = (f) => { const v = good.map(f).filter((x) => Number.isFinite(x)); return v.length ? Math.round((v.reduce((a, c) => a + c, 0) / v.length) * 1000) / 1000 : null; };
  const sides = ["yes_case", "no_case", "evenly_matched", "not_enough_evidence"];
  const summary = {
    pYes: avg((r) => r.answers.outcome?.noul),
    pYesFactsOnly: avg((r) => r.answers.outcome_facts_only?.noul),
    orderSpread: good.length === 2 ? Math.round(Math.abs(good[0].answers.outcome?.noul - good[1].answers.outcome?.noul) * 1000) / 1000 : null,
    strongerCase: Object.fromEntries(sides.map((k) => [k, avg((r) => r.answers.stronger_case?.probabilities?.[k] ?? 0)])),
    yesStrength: avg((r) => r.answers.yes_strength?.fraction),
    noStrength: avg((r) => r.answers.no_strength?.fraction),
  };
  return json({ summary, runs, questionsVersion: QUESTIONS_VERSION, note: "Jev weighs the evidence it is given. This is not a forecast with a track record." }, 200, cors);
}

async function callJev(apiKey, state, questions = QUESTIONS) {
  const payload = JSON.stringify({ model: TYPESAFE_MODEL, state, questions });
  let delay = 600;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: payload,
    });
    if (r.ok) return await r.json();
    if (r.status === 429 || r.status === 529 || r.status >= 500) {
      await sleep(delay + Math.random() * 300);
      delay *= 2;
      continue;
    }
    const text = await r.text().catch(() => "");
    return { error: `jev ${r.status}: ${text.slice(0, 200)}` };
  }
  return { error: "jev busy (rate limited or overloaded), try again shortly" };
}

// Give the page one clean shape regardless of small API variations:
//   choice -> { choice, probabilities (keys = our option names), confidence }
//   score  -> { fraction 0..1 or null, score, probabilities, legend, confidence }
//   noul   -> { noul }
export function normalizeAnswers(answers, questions = QUESTIONS) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = answers && answers[id];
    if (!a || typeof a !== "object") continue;
    if (q.type === "choice") {
      const opts = Object.keys(q.criteria);
      const match = (k) => opts.find((o) => o.toLowerCase() === String(k).toLowerCase());
      const probs = {};
      for (const [k, v] of Object.entries(a.probabilities || {})) { const m = match(k); if (m && Number.isFinite(+v)) probs[m] = +v; }
      let choice = a.choice != null ? match(a.choice) : null;
      if (!choice && Object.keys(probs).length) choice = Object.entries(probs).sort((x, y) => y[1] - x[1])[0][0];
      out[id] = { type: "choice", choice: choice || null, probabilities: probs, confidence: a.confidence ?? null };
    } else if (q.type === "score") {
      const n = q.criteria.length;
      let e = 0, tot = 0;
      for (const [k, v] of Object.entries(a.probabilities || {})) {
        const i = /^\d+$/.test(k) ? +k : q.criteria.indexOf(k);
        if (i >= 0 && i < n && Number.isFinite(+v)) { e += i * +v; tot += +v; }
      }
      let fraction = tot > 0 ? e / tot / (n - 1) : null;
      if (fraction === null && Number.isFinite(+a.score)) {
        const legendN = a.legend ? Object.keys(a.legend).length : 0;
        if (legendN === n && +a.score >= 0 && +a.score <= n - 1) fraction = +a.score / (n - 1);
      }
      out[id] = { type: "score", fraction: fraction === null ? null : Math.max(0, Math.min(1, fraction)), score: a.score ?? null, probabilities: a.probabilities || {}, legend: a.legend || null, confidence: a.confidence ?? null };
    } else {
      const v = +a.noul;
      out[id] = { type: "noul", noul: Number.isFinite(v) ? v : null };
    }
  }
  return out;
}

// ---------------------------------------------------------------- X / Twitter

async function handleX(url, env, ctx, cors) {
  if (!env.TWITTERAPI_IO_KEY) return json({ error: "TWITTERAPI_IO_KEY secret is not set" }, 503, cors);
  const ca = (url.searchParams.get("ca") || "").trim();
  if (!/^[A-Za-z0-9:_]+$/.test(ca)) return json({ error: "bad ca" }, 400, cors);
  const sym = (url.searchParams.get("sym") || "").replace(/[^A-Za-z0-9_぀-ヿ㐀-鿿가-힯]/g, "").slice(0, 24);
  const handle = (url.searchParams.get("handle") || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
  if (!ca || ca.length < 20 || ca.length > 64) return json({ error: "ca required" }, 400, cors);

  const cacheKey = await cacheUrl("x", [ca, sym, handle].join("|"));
  const hit = await caches.default.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { ...cors, "Content-Type": "application/json", "X-Cache": "HIT" } });

  const key = env.TWITTERAPI_IO_KEY;
  const [caSearch, symSearch, user] = await Promise.all([
    twGet(key, "/twitter/tweet/advanced_search", { query: `"${ca}"`, queryType: "Latest" }),
    sym ? twGet(key, "/twitter/tweet/advanced_search", { query: "$" + sym, queryType: "Latest" }) : null,
    handle ? twGet(key, "/twitter/user/info", { userName: handle }) : null,
  ]);

  const out = {
    fetchedAt: Date.now(),
    ca: summarizeTweets(caSearch),
    ticker: sym ? summarizeTweets(symSearch, true) : null,
    official: handle ? summarizeUser(user, handle) : null,
  };
  ctx.waitUntil(caches.default.put(cacheKey, cacheable(out, HOUR)));
  return json(out, 200, cors);
}

async function twGet(key, path, params) {
  const u = new URL(TW_BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "X-API-Key": key } });
  if (!r.ok) return { error: "twitterapi " + r.status };
  return r.json().catch(() => ({ error: "bad json" }));
}

function summarizeTweets(res, light = false) {
  if (!res || res.error) return { error: res ? res.error : "no data" };
  const tweets = Array.isArray(res.tweets) ? res.tweets : [];
  const now = Date.now();
  const authors = new Map();
  const texts = new Map();
  let newest = null;
  for (const t of tweets) {
    const a = t.author || {};
    const name = a.userName || a.username || "?";
    if (!authors.has(name)) {
      const created = Date.parse(a.createdAt || "");
      authors.set(name, {
        followers: Number(a.followers || 0),
        ageDays: Number.isFinite(created) ? Math.round((now - created) / 86400000) : null,
        blue: Boolean(a.isBlueVerified),
      });
    }
    const norm = String(t.text || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    texts.set(norm, (texts.get(norm) || 0) + 1);
    const ts = Date.parse(t.createdAt || "");
    if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
  }
  const list = [...authors.values()];
  const tiny = list.filter((a) => a.followers < 50 || (a.ageDays !== null && a.ageDays < 30)).length;
  const dupes = [...texts.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
  const out = {
    tweets: tweets.length,
    moreAvailable: Boolean(res.has_next_page),
    uniqueAuthors: list.length,
    tinyOrNewAuthorShare: list.length ? round2(tiny / list.length) : null,
    duplicateTextShare: tweets.length ? round2(dupes / tweets.length) : null,
    medianFollowers: median(list.map((a) => a.followers)),
    newestMinutesAgo: newest ? Math.round((now - newest) / 60000) : null,
  };
  if (!light) {
    out.sample = tweets.slice(0, 4).map((t) => ({
      text: String(t.text || "").slice(0, 200),
      followers: Number(t.author?.followers || 0),
      likes: Number(t.likeCount || 0),
    }));
  }
  return out;
}

function summarizeUser(res, handle) {
  if (!res || res.error) return { handle, error: res ? res.error : "no data" };
  const d = res.data || {};
  if (d.unavailable) return { handle, unavailable: true };
  const created = Date.parse(d.createdAt || "");
  return {
    handle: d.userName || handle,
    followers: Number(d.followers || 0),
    posts: Number(d.statusesCount || 0),
    ageDays: Number.isFinite(created) ? Math.round((Date.now() - created) / 86400000) : null,
    blue: Boolean(d.isBlueVerified),
  };
}

// ---------------------------------------------------------------- Relay

async function handleRelay(request, url, ctx, cors) {
  const target = url.searchParams.get("u") || "";
  let t;
  try { t = new URL(target); } catch { return json({ error: "bad url" }, 400, cors); }
  if (t.protocol !== "https:") return json({ error: "https only" }, 400, cors);

  if (request.method === "GET") {
    if (!RELAY_GET_HOSTS.has(t.hostname)) return json({ error: "host not allowed" }, 403, cors);
    const key = new Request("https://relay.cache/" + encodeURIComponent(t.toString()));
    const hit = await caches.default.match(key);
    if (hit) return new Response(hit.body, { status: hit.status, headers: { ...cors, "Content-Type": "application/json" } });
    const r = await fetch(t.toString(), { headers: { "Accept": "application/json" }, redirect: "manual" });
    const text = await r.text();
    const resp = new Response(text, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "max-age=30" } });
    if (r.ok) ctx.waitUntil(caches.default.put(key, resp.clone()));
    return new Response(text, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  }

  if (request.method === "POST") {
    if (!RELAY_POST_HOSTS.has(t.hostname)) return json({ error: "host not allowed" }, 403, cors);
    const body = await request.text();
    if (body.length > 20000) return json({ error: "body too large" }, 400, cors);
    let parsed;
    try { parsed = JSON.parse(body); } catch { return json({ error: "bad json" }, 400, cors); }
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    if (!calls.every((c) => RPC_METHODS.has(c && c.method))) return json({ error: "rpc method not allowed" }, 403, cors);
    const r = await fetch(t.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "manual" });
    return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  }

  return json({ error: "method not allowed" }, 405, cors);
}

// ---------------------------------------------------------------- helpers

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function cacheable(obj, seconds) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
  });
}

async function cacheUrl(ns, text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(`https://cache.trench-scanner/${ns}/${hex}`);
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
