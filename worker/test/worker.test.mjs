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
    assert.ok((body.questions.grade && body.questions.verdict) || body.questions.outcome);
    assert.equal(init.headers.Authorization, "Bearer test-key");
    if (body.questions.outcome) {
      assert.deepEqual(Object.keys(body.questions).sort(), ["no_strength", "outcome", "outcome_facts_only", "stronger_case", "yes_strength"]);
      const yesFirst = Object.keys(body.state).indexOf("yesCase") < Object.keys(body.state).indexOf("noCase");
      return Response.json({ model: "jev-1.13", answers: { outcome: { noul: yesFirst ? 0.4 : 0.3 }, outcome_facts_only: { noul: 0.25 }, stronger_case: { choice: "no_case", probabilities: { yes_case: 0.2, no_case: 0.6, evenly_matched: 0.2, not_enough_evidence: 0 } }, yes_strength: { probabilities: { 2: 1 } }, no_strength: { probabilities: { 3: 1 } } }, usage: { input_tokens: 500 } });
    }
    if (body.questions.thesis) {
      assert.deepEqual(Object.keys(body.questions.thesis.criteria), ["d1", "d2", "none"]);
      assert.equal(body.state.thesisCandidates, undefined, "candidates stripped from state");
      return Response.json({ model: "jev-1.13", answers: { thesis: { choice: "D2", probabilities: { d1: 0.2, d2: 0.7, none: 0.1 } }, narrative: { choice: "animal_pet", probabilities: { animal_pet: 0.9 } } }, usage: {} });
    }
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
r = await req("/jev", { method: "POST", body: JSON.stringify({ coins: [{ id: "t1", state: { coin: { symbol: "PAW" }, thesisCandidates: [{ id: "d1", text: "The first dog on the moon, for real." }, { id: "d2", text: "A pixel dog that paints every holder's portrait." }, { id: "BAD ID", text: "ignored" }] } }] }) });
j = await r.json();
assert.equal(j.results.t1.answers.thesis.choice, "d2", "thesis choice normalised to candidate id");
assert.equal(j.results.t1.answers.narrative.choice, "animal_pet");
r = await req("/jev/claim", { method: "POST", body: JSON.stringify({ claim: "X closes above 6.50", horizon: "by tomorrow", facts: { last: 6.49 }, yes: ["momentum"], no: ["resistance", "x".repeat(900)] }) });
j = await r.json();
assert.equal(r.status, 200);
assert.equal(j.summary.pYes, 0.35, "averaged over both orders");
assert.equal(j.summary.orderSpread, 0.1);
assert.equal(j.summary.pYesFactsOnly, 0.25);
assert.equal(j.summary.strongerCase.no_case, 0.6);
assert.equal(j.summary.yesStrength, 0.5); assert.equal(j.summary.noStrength, 0.75);
assert.equal(j.runs.length, 2);
r = await req("/jev/claim", { method: "POST", body: JSON.stringify({ claim: "X", horizon: "soon", yes: [], no: ["a"] }) });
assert.equal(r.status, 400, "both cases required");
limited = 1;
r = await req("/x?ca=So11111111111111111111111111111111111111112");
assert.equal(r.status, 429, "rate limiter enforced");
r = await req("/x?ca=" + encodeURIComponent("abc) OR (from:elon"));
assert.equal(r.status, 400, "search operators rejected");
console.log("worker tests passed");
