// Offline test: stubs fetch + caches, checks routing, origin lock, Jev batching,
// retry on 429, caching, X summary and relay allowlist.
import assert from "node:assert/strict";

const store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const r = store.get(req.url); return r ? r.clone() : undefined; },
  put: async (req, res) => { store.set(req.url, res.clone()); },
}};
const calls = [];
let fail429 = 1;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, init });
  if (url.startsWith("https://api.typesafe.ai")) {
    if (fail429-- > 0) return new Response("slow down", { status: 429 });
    const body = JSON.parse(init.body);
    assert.equal(body.model, "jev-latest");
    assert.ok(body.questions.grade && body.questions.verdict);
    assert.equal(init.headers.Authorization, "Bearer test-key");
    return Response.json({ model: "jev-1.13", answers: { grade: { type: "choice", choice: "B", probabilities: { A: .3, B: .35, C: .2, D: .1, F: .05 }, confidence: .4 } }, usage: { input_tokens: 900, output_tokens: 0 } });
  }
  if (url.startsWith("https://api.twitterapi.io/twitter/tweet")) {
    return Response.json({ tweets: [
      { text: "buy $CAT now https://x.co/a", createdAt: new Date().toUTCString(), author: { userName: "a", followers: 10, createdAt: new Date().toUTCString() } },
      { text: "buy $CAT now https://x.co/b", createdAt: new Date().toUTCString(), author: { userName: "b", followers: 5000, createdAt: "Tue Dec 10 07:00:30 +0000 2019" } },
    ], has_next_page: false });
  }
  if (url.startsWith("https://api.twitterapi.io/twitter/user")) return Response.json({ status: "success", data: { userName: "catcoin", followers: 1234, statusesCount: 50, createdAt: "Tue Dec 10 07:00:30 +0000 2024" } });
  if (url.startsWith("https://api.dexscreener.com")) return Response.json({ pairs: [] });
  throw new Error("unexpected fetch " + url);
};

const { default: worker, normalizeAnswers } = await import("../src/index.js");
// normalisation: lower-case keys, missing choice, text-keyed score probabilities, legend-only score
const n = normalizeAnswers({
  grade: { probabilities: { a: 0.2, b: 0.5, c: 0.3 } },
  verdict: { choice: "pass", probabilities: {} },
  lore: { probabilities: { "Minimal: a ticker plus a generic line or a single link": 1 } },
  heat: { score: 2, legend: { 0: "", 1: "", 2: "", 3: "", 4: "" } },
  trend: { score: 7 },
  rebound: { noul: "0.8" },
});
assert.equal(n.grade.choice, "B"); assert.deepEqual(Object.keys(n.grade.probabilities).sort(), ["A", "B", "C"]);
assert.equal(n.verdict.choice, "PASS");
assert.equal(n.lore.fraction, 0.25);
assert.equal(n.heat.fraction, 0.5);
assert.equal(n.trend.fraction, null, "unreadable score stays null");
assert.equal(n.rebound.noul, 0.8);
let limited = 0;
const env = { LIMITER: { limit: async () => ({ success: limited-- <= 0 }) }, TYPESAFE_API_KEY: "test-key", TWITTERAPI_IO_KEY: "tw", ALLOWED_ORIGINS: "https://guerakun.github.io" };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const O = { Origin: "https://guerakun.github.io" };
const req = (path, init = {}) => worker.fetch(new Request("https://w.dev" + path, { ...init, headers: { ...O, ...(init.headers || {}) } }), env, ctx);

let r = await worker.fetch(new Request("https://w.dev/health"), env, ctx);
assert.deepEqual((await r.json()).jev, true);

r = await worker.fetch(new Request("https://w.dev/jev/schema", { headers: { Origin: "https://evil.example" } }), env, ctx);
assert.equal(r.status, 403, "foreign origin blocked");

r = await req("/jev/schema");
const sch = await r.json();
assert.deepEqual(sch.questions.grade.options, ["A", "B", "C", "D", "F"]);
assert.equal(sch.questions.lore.levels.length, 5);

const state = { coin: { symbol: "CAT" }, rules: { grade: "B" } };
r = await req("/jev", { method: "POST", body: JSON.stringify({ coins: [{ id: "c1", state }, { id: "c2", state: { coin: { symbol: "DOG" } } }] }) });
let j = await r.json();
assert.equal(j.results.c1.answers.grade.choice, "B");
assert.equal(j.results.c2.answers.grade.choice, "B");
assert.ok(calls.filter((c) => c.url.includes("typesafe")).length >= 3, "retried after 429");
await Promise.all(waits);
const before = calls.length;
r = await req("/jev", { method: "POST", body: JSON.stringify({ coins: [{ id: "c1", state }] }) });
j = await r.json();
assert.equal(j.usage.cached, 1); assert.equal(calls.length, before, "served from cache");

r = await req("/x?ca=So11111111111111111111111111111111111111112&sym=CAT&handle=catcoin");
j = await r.json();
assert.equal(j.ca.uniqueAuthors, 2);
assert.equal(j.ca.duplicateTextShare, 1);
assert.equal(j.ca.tinyOrNewAuthorShare, 0.5);
assert.equal(j.official.followers, 1234);

r = await req("/relay?u=" + encodeURIComponent("https://evil.example/x"));
assert.equal(r.status, 403);
r = await req("/relay?u=" + encodeURIComponent("https://api.dexscreener.com/latest/dex/tokens/abc"));
assert.equal(r.status, 200);
r = await req("/relay?u=" + encodeURIComponent("https://api.mainnet-beta.solana.com"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] }) });
assert.equal(r.status, 403, "only read RPC methods relayed");

r = await worker.fetch(new Request("https://w.dev/jev", { method: "POST", headers: O, body: "{}" }), { ...env, TYPESAFE_API_KEY: "" }, ctx);
assert.equal(r.status, 503);
limited = 1;
r = await req("/x?ca=So11111111111111111111111111111111111111112");
assert.equal(r.status, 429, "rate limiter enforced");
r = await req("/x?ca=" + encodeURIComponent("abc) OR (from:elon"));
assert.equal(r.status, 400, "search operators rejected");
console.log("worker tests passed");
