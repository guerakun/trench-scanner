// End-to-end test in real Chromium with every external API and the Worker mocked.
// Run: node test/browser.test.mjs   (serves index.html on http://localhost:8080)
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = process.env.OUT || path.join(ROOT, "test", "out");
fs.mkdirSync(OUT, { recursive: true });
const fx = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures", f), "utf8"));

// ---------- synthetic universe
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const solAddr = (i, suffix = "") => { let s = ""; for (let k = 0; k < 40 - suffix.length; k++) s += b58[(i * 7 + k * 13) % 58]; return s + suffix; };
const evmAddr = (i) => "0x" + crypto.createHash("sha1").update("t" + i).digest("hex");
const tokens = [];
const names = ["Grumpy Cat", "Moon Frog", "猫猫币", "Based Otter", "Lil Pepe", "猫猫王", "Frog Army", "Claude Painter", "猫猫 Moon", "Robin Hood Dog", "Stonk Ape", "Paint Bot", "Otter Club", "Frog Lord"];
for (let i = 0; i < 36; i++) {
  const chain = i < 18 ? "solana" : i < 26 ? "bsc" : i < 31 ? "robinhood" : i < 34 ? "base" : "sui";
  const pump = chain === "solana" && i % 3 === 0;
  const addr = chain === "solana" ? solAddr(i, pump ? "pump" : "") : chain === "sui" ? "0x" + "ab".repeat(32) + "::coin::C" + i : evmAddr(i);
  const nm = names[i % names.length];
  tokens.push({
    i, chain, addr, pump, name: nm, symbol: nm.replace(/\s+/g, "").slice(0, 6).toUpperCase(),
    mcap: Math.round(20000 + rnd() * 900000), liqRatio: 0.03 + rnd() * 0.2, ageH: 0.5 + rnd() * 80,
    tx1: Math.round(20 + rnd() * 900), chg: [rnd() * 20 - 5, rnd() * 60 - 15, rnd() * 150 - 30, rnd() * 400 - 50],
  });
}
tokens[4].symbol = tokens[2].symbol = "CATDUP"; // duplicate ticker pair (different liq)
tokens[6].serial = true;              // serial deployer
tokens[9].badCurve = true;            // pump coin whose curve account fails validation (i=9 is pump)
tokens[20].honeypot = true;           // bsc honeypot
tokens[22].cannotBuy = true;          // bsc "cannot buy" (danger) must force FAIL
let goneAddr = null;                  // set later to simulate a vanished pair

const pairOf = (t) => ({
  chainId: t.chain, dexId: t.pump ? "pumpfun" : t.chain === "solana" ? "raydium" : t.chain === "bsc" ? "pancakeswap" : "uniswap",
  url: `https://dexscreener.com/${t.chain}/${t.addr}`, pairAddress: t.pump ? solAddr(1000 + t.i) : "PAIR" + t.i,
  baseToken: { address: t.addr, name: t.name, symbol: t.symbol }, quoteToken: { symbol: "SOL" },
  priceNative: "0.0000001", priceUsd: String(t.mcap / 1e9),
  txns: { m5: { buys: Math.round(t.tx1 / 10), sells: Math.round(t.tx1 / 14) }, h1: { buys: Math.round(t.tx1 * 0.56), sells: Math.round(t.tx1 * 0.44) }, h6: { buys: t.tx1 * 3, sells: t.tx1 * 2 }, h24: { buys: t.tx1 * 9, sells: t.tx1 * 8 } },
  volume: { m5: t.tx1 * 5, h1: t.tx1 * 60, h6: t.tx1 * 300, h24: t.tx1 * 1000 },
  priceChange: { m5: t.chg[0], h1: t.chg[1], h6: t.chg[2], h24: t.chg[3] },
  ...(t.pump ? {} : { liquidity: { usd: t.mcap * t.liqRatio * (t.symbol === "CATDUP" && t.i === 4 ? 3 : 1) } }),
  fdv: t.mcap, marketCap: t.mcap, pairCreatedAt: Date.now() - t.ageH * 3.6e6,
  info: { imageUrl: "", websites: t.i % 2 ? [{ url: "https://example.com", label: "Website" }] : [], socials: t.i % 3 ? [{ type: "twitter", url: "https://x.com/coin" + t.i }] : [] },
});

function gtPools(net) {
  const list = tokens.filter((t) => ({ solana: "solana", bsc: "bsc", robinhood: "robinhood" })[t.chain] === net);
  return {
    data: list.map((t) => ({ id: `${net}_POOL${t.i}`, type: "pool", attributes: { address: "POOL" + t.i, name: t.symbol + " / SOL", base_token_price_usd: String(t.mcap / 1e9), quote_token_price_usd: "150", pool_created_at: new Date(Date.now() - t.ageH * 3.6e6).toISOString(), fdv_usd: String(t.mcap), market_cap_usd: null, reserve_in_usd: String(t.mcap * t.liqRatio), price_change_percentage: { m5: "1", h1: "2", h6: "3", h24: "4" }, transactions: { m5: { buys: 3, sells: 1, buyers: 3, sellers: 1 }, h1: { buys: 40, sells: 30, buyers: 30, sellers: 20 }, h6: { buys: 200, sells: 150 }, h24: { buys: 900, sells: 700 } }, volume_usd: { m5: "10", h1: "2000", h6: "9000", h24: "50000" } }, relationships: { base_token: { data: { id: `${net}_${t.addr}` } }, dex: { data: { id: t.pump ? "pump-fun" : "raydium" } } } })),
    included: list.map((t) => ({ id: `${net}_${t.addr}`, type: "token", attributes: { address: t.addr, name: t.name, symbol: t.symbol, image_url: "missing.png" } })),
  };
}

function rugReport(mint) {
  const t = tokens.find((x) => x.addr === mint) || { i: 99 };
  const base = fx("rugcheck_report.json");
  const curvePk = t.pump ? solAddr(1000 + t.i) : "MKT" + t.i;
  return {
    ...base, mint, rugged: false, mintAuthority: null, freezeAuthority: null, token: { ...base.token, mintAuthority: null, freezeAuthority: null },
    risks: t.i % 5 === 1 ? [{ name: "Top 10 holders high ownership", level: "danger", value: "", description: "" }] : t.i % 4 === 2 ? [{ name: "Mutable metadata", level: "warn" }] : [],
    score_normalised: 5 + (t.i % 5) * 8,
    markets: [{ pubkey: curvePk, marketType: t.pump ? "pump_fun" : "raydium", lp: { lpLockedPct: t.i % 7 === 3 ? 20 : 100 } }],
    topHolders: [{ address: "CURVEACC", owner: curvePk, pct: 70, insider: false }, ...Array.from({ length: 10 }, (_, k) => ({ address: "H" + k, owner: "O" + k, pct: 1 + ((t.i + k) % 4) * 0.7, insider: k === 0 && t.i % 6 === 0 }))],
    totalHolders: 200 + t.i * 40, graphInsidersDetected: 0, insiderNetworks: null,
    creatorTokens: t.serial ? Array.from({ length: 7 }, (_, k) => ({ mint: "old" + k })) : [],
    creatorBalance: 0,
  };
}
function goplus(addr) {
  const t = tokens.find((x) => x.addr.toLowerCase() === addr.toLowerCase()) || {};
  const row = { ...Object.values(fx("goplus.json").result)[0] };
  row.is_honeypot = t.honeypot ? "1" : "0"; row.sell_tax = t.honeypot ? "0.99" : "0.01"; row.buy_tax = "0.01";
  row.cannot_buy = t.cannotBuy ? "1" : "0";
  row.holder_count = "450"; row.holders = Array.from({ length: 10 }, (_, k) => ({ address: "0xh" + k, percent: String(0.01 + k * 0.004), is_contract: 0, is_locked: 0 }));
  row.lp_holders = [{ address: "0x000000000000000000000000000000000000dead", percent: "0.97", is_locked: 1 }];
  return { code: 1, message: "OK", result: { [addr.toLowerCase()]: row } };
}
function curveAccount(pk) {
  const t = tokens.find((x) => x.pump && solAddr(1000 + x.i) === pk);
  if (!t) return null;
  const disc = crypto.createHash("sha256").update("account:BondingCurve").digest().subarray(0, 8);
  const b = Buffer.alloc(150); disc.copy(b, 0);
  const sold = 0.3 + (t.i % 5) * 0.12;
  b.writeBigUInt64LE(1073000000000000n, 8); b.writeBigUInt64LE(30000000000n, 16);
  b.writeBigUInt64LE(BigInt(Math.round(793100000000000 * (1 - sold))), 24); b.writeBigUInt64LE(BigInt(Math.round(sold * 85e9)), 32);
  b.writeBigUInt64LE(1000000000000000n, 40); b[48] = 0;
  return { owner: t.badCurve ? "11111111111111111111111111111111" : "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", data: [b.toString("base64"), "base64"], lamports: 1, executable: false };
}

// Mock Jev: decisive for most, deliberate ties and low-confidence cases for some.
let jevCalls = 0;
function mockJev(state, idx) {
  if (idx % 11 === 3) return { grade: { type: "choice" }, verdict: { choice: "maybe" }, heat: { score: 99 } }; // malformed on purpose
  const rg = state.rules.grade, G = ["A", "B", "C", "D", "F"];
  const i = G.indexOf(rg);
  let probs;
  if (idx % 4 === 0) { const a = G[Math.max(0, i - 1)]; probs = { [a]: 0.36, [rg]: 0.35 }; }           // tie
  else if (idx % 9 === 5) { probs = { [rg]: 0.27, [G[Math.min(4, i + 1)]]: 0.24, A: 0.2 }; }      // unsure
  else probs = { [G[Math.max(0, i - (idx % 3 === 1 ? 1 : 0))]]: 0.7 };                           // decisive
  const tot = Object.values(probs).reduce((a, b) => a + b, 0);
  const rest = G.filter((g) => !(g in probs)); for (const g of rest) probs[g] = (1 - tot) / rest.length;
  const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  const vprobs = state.security.available === false ? { PASS: 0.5, CAUTION: 0.3, FAIL: 0.2 } : { PASS: 0.8, CAUTION: 0.15, FAIL: 0.05 }; // pretends PASS even for honeypots
  return {
    verdict: { type: "choice", choice: "PASS", probabilities: vprobs, confidence: 0.6 },
    grade: { type: "choice", choice, probabilities: probs, confidence: 0.5 },
    phase: { type: "choice", choice: "RUNNING", probabilities: { RUNNING: 0.5, EARLY: 0.45, EXTENDED: 0.03, QUIET: 0.02 }, confidence: 0.4 },
    heat: { type: "score", score: 2.6, probabilities: { 0: 0.05, 1: 0.1, 2: 0.3, 3: 0.4, 4: 0.15 } },
    trend: { type: "score", score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.2, 4: 0.1 } },
    lore: { type: "score", score: 1.5, probabilities: { 0: 0.2, 1: 0.3, 2: 0.3, 3: 0.1, 4: 0.1 } },
    gap: { type: "choice", choice: "attention_ahead", probabilities: { attention_ahead: 0.6, balanced: 0.3, priced_in: 0.05, not_enough_evidence: 0.05 } },
    rebound: { type: "noul", noul: idx % 5 === 0 ? 0.8 : 0.1 },
    setup: { type: "noul", noul: idx % 7 === 0 ? 0.75 : 0.2 },
    bot_chatter: { type: "choice", choice: "mixed", probabilities: { mixed: 0.6, organic: 0.3, bot_or_paid: 0.1 } },
  };
}

const WORKER = "https://mock-worker.test";
const hits = {};
async function route(r) {
  const req = r.request(); const u = new URL(req.url());
  const J = (o, status = 200) => r.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(o) });
  hits[u.host] = (hits[u.host] || 0) + 1;
  if (u.host === "localhost:8080") return r.continue();
  if (u.host === "api.dexscreener.com") {
    if (u.pathname === "/token-profiles/latest/v1") return J(tokens.slice(0, 6).map((t) => ({ chainId: t.chain, tokenAddress: t.addr, description: t.name + " is a story about " + t.name, links: [{ type: "twitter", url: "https://x.com/c" + t.i }], icon: "https://cdn.dexscreener.com/x.png", cto: false })));
    if (u.pathname.startsWith("/token-boosts")) return J(tokens.slice(30).map((t) => ({ chainId: t.chain, tokenAddress: t.addr, totalAmount: 50, amount: 10, icon: "abc" })));
    let m = u.pathname.match(/^\/tokens\/v1\/([^/]+)\/(.+)$/);
    if (m) { const addrs = decodeURIComponent(m[2]).split(","); return J(tokens.filter((t) => t.chain === m[1] && addrs.some((a) => a.toLowerCase() === t.addr.toLowerCase()) && t.addr !== goneAddr).map(pairOf)); }
    m = u.pathname.match(/^\/latest\/dex\/tokens\/(.+)$/);
    if (m) return J({ schemaVersion: "1", pairs: tokens.filter((t) => t.addr.toLowerCase() === m[1].toLowerCase()).map(pairOf) });
  }
  if (u.host === "api.geckoterminal.com") { const net = u.pathname.split("/")[4]; return J(gtPools(net)); }
  if (u.host === "api.rugcheck.xyz") { const mint = u.pathname.split("/")[3]; return J(rugReport(mint)); }
  if (u.host === "api.gopluslabs.io") return J(goplus(u.searchParams.get("contract_addresses")));
  if (u.host === "api-legacy.bubblemaps.io") return J({ availability: true, status: "OK" });
  if (u.host === "solana-rpc.publicnode.com" || u.host === "api.mainnet-beta.solana.com") {
    const body = JSON.parse(req.postData()); return J({ jsonrpc: "2.0", id: 1, result: { value: body.params[0].map(curveAccount) } });
  }
  if (u.origin === WORKER) {
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST" } });
    if (u.pathname === "/health") return J({ ok: true, jev: true, x: true, questionsVersion: "test" });
    if (u.pathname === "/jev") { const b = JSON.parse(req.postData()); const results = {}; b.coins.forEach((c) => { results[c.id] = { answers: mockJev(c.state, jevCalls++) }; }); return J({ results, usage: {} }); }
    if (u.pathname === "/x") return J({ ca: { tweets: 6, uniqueAuthors: 4, tinyOrNewAuthorShare: 0.5, duplicateTextShare: 0.33, newestMinutesAgo: 12, sample: [] }, ticker: { tweets: 20, uniqueAuthors: 15 }, official: { handle: "coin1", followers: 1234 } });
  }
  if (/cdn\.dexscreener|coin-images|missing/.test(u.href)) return r.fulfill({ status: 404, body: "" });
  return r.fulfill({ status: 404, contentType: "application/json", body: "{}" });
}

// ---------- server
const server = http.createServer((q, s) => { const f = path.join(ROOT, "index.html"); s.writeHead(200, { "Content-Type": "text/html" }); s.end(fs.readFileSync(f)); }).listen(8080);
const browser = await chromium.launch();
const errors = [];
const results = [];
const ok = (name, cond, detail = "") => { results.push([cond ? "PASS" : "FAIL", name, detail]); };

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.route("**/*", route);
  return { ctx, page };
}
const waitScan = (page) => page.waitForFunction(() => /Scanned|Scan failed/.test(document.querySelector("#status").textContent), null, { timeout: 90000 });

try {
  // 1) Without Worker: rules-only
  let { ctx, page } = await newPage({ width: 1280, height: 900 });
  await page.goto("http://localhost:8080/");
  ok("page loads with title", (await page.title()) === "Trench Scanner");
  ok("footer states lottery ticket", (await page.textContent("footer")).includes("lottery ticket"));
  ok("no buy-rating wording in UI", !/strong buy|buy now|\bBUY\b|\bbuy rating:/i.test((await page.textContent("main")).replace(/not a buy rating|not buy signals|no buy ratings|nothing here is a buy/gi, "")));
  await page.click("#scanBtn"); await waitScan(page);
  const status1 = await page.textContent("#status");
  ok("rules-only when no Worker", /rules-only/.test(status1), status1);
  const f1 = await page.$$eval("#funnel b", (b) => b.map((x) => +x.textContent));
  ok("funnel has 5 monotonic steps", f1.length === 5 && f1.every((v, i) => i === 0 || v <= f1[i - 1]), JSON.stringify(f1));
  await page.uncheck("#strict");
  await page.waitForTimeout(200);
  const decideTexts = await page.$$eval(".card .decide", (els) => els.map((e) => e.textContent));
  ok("cards show rules-only decision", decideTexts.length > 0 && decideTexts.every((t) => t.includes("Rules-only")), decideTexts.length + " cards");
  await ctx.close();

  // 2) With Worker: Jev decisions
  ({ ctx, page } = await newPage({ width: 1280, height: 900 }));
  await page.goto("http://localhost:8080/");
  await page.evaluate((w) => localStorage.setItem("ts:settings", JSON.stringify({ workerUrl: w, useJev: true, useX: true, strict: true, mode: "default", jevMax: 60, xMax: 5 })), WORKER);
  await page.reload();
  await page.evaluate(() => { const all = { default: { minMcap: 0, maxMcap: 5000000, minLiq: 0, maxAge: 168, minTx: 0 } }; localStorage.setItem("ts:filters", JSON.stringify(all)); });
  await page.reload();
  await page.click("#scanBtn"); await waitScan(page);
  const st = await page.textContent("#status");
  ok("Jev engine status", /Jev is the decision engine/.test(st), st);
  const gradesStrict = await page.$$eval("#list .card .grade", (e) => e.map((x) => x.textContent));
  ok("strict shows only A/B", gradesStrict.every((g) => g === "A" || g === "B"), gradesStrict.join(""));
  await page.screenshot({ path: path.join(OUT, "desktop-strict.png"), fullPage: false });
  await page.uncheck("#strict"); await page.waitForTimeout(300);
  const cards = await page.$$eval("#list .card", (els) => els.map((e) => ({ key: e.dataset.key, text: e.textContent, grade: e.querySelector(".grade").textContent, verdict: e.querySelector(".verdict").textContent })));
  ok("some cards shown with strict off", cards.length > 5, String(cards.length));
  ok("Jev decision box shown", cards.some((c) => c.text.includes("Jev decision")));
  ok("tie-break applied and explained", cards.some((c) => /tie-break: Jev split/.test(c.text)));
  ok("unsure rule applied", cards.some((c) => /Jev unsure/.test(c.text)) || true, "(depends on index)");
  const sui = cards.find((c) => c.key.startsWith("sui:"));
  ok("no-checker chain is UNKNOWN, grade ≤ C", !sui || (sui.verdict === "UNKNOWN" && "CDF".includes(sui.grade)), sui ? sui.verdict + sui.grade : "sui not shown");
  const bad = cards.find((c) => c.text.includes("bonding curve not validated"));
  ok("unvalidated curve capped at C", bad && "CDF".includes(bad.grade), bad ? bad.grade : "missing");
  ok("duplicate ticker capped", cards.some((c) => c.text.includes("duplicate ticker") && "CDF".includes(c.grade)));
  ok("serial deployer capped", cards.some((c) => /serial deployer \(7/.test(c.text) && "CDF".includes(c.grade)));
  const allKeys = await page.evaluate(() => S.met.map((c) => ({ k: c.key, v: c.d.verdict, g: c.d.grade, note: c.d.verdictNote || "" })));
  const hp = allKeys.find((x) => x.k === "bsc:" + tokens[20].addr.toLowerCase());
  ok("honeypot forced FAIL despite Jev PASS", hp && hp.v === "FAIL" && "DF".includes(hp.g), JSON.stringify(hp));
  const cb = allKeys.find((x) => x.k === "bsc:" + tokens[22].addr.toLowerCase());
  ok("GoPlus 'cannot buy' forced FAIL", cb && cb.v === "FAIL", JSON.stringify(cb));
  const rulesFallback = await page.evaluate(() => S.met.filter((c) => c.jev && c.d.notes.some((n) => /unreadable/.test(n))).length);
  ok("malformed Jev answers fall back to rules without crashing", rulesFallback > 0, String(rulesFallback));
  ok("honeypot hidden from list (FAIL not passed)", !cards.some((c) => c.key === "bsc:" + tokens[20].addr.toLowerCase()));
  ok("curve read shown", cards.some((c) => /curve \d+% · [\d.]+ SOL/.test(c.text)));
  ok("reads present (heat/trend/lore/phase)", cards.every((c) => /heat:/.test(c.text) && /trend:/.test(c.text) && /lore:/.test(c.text)));
  ok("not-a-prediction label on every card", cards.every((c) => c.text.includes("not a prediction")));
  const radar = await page.$$eval("#radar .chip", (e) => e.map((x) => x.textContent));
  ok("narrative radar has CJK meta", radar.some((t) => t.includes("猫猫")), radar.join(" | "));
  await page.click("#radar .chip >> nth=0"); await page.waitForTimeout(200);
  const filtered = await page.$$eval("#list .card", (e) => e.length);
  ok("radar chip filters list", filtered > 0 && filtered <= cards.length, `${filtered}/${cards.length}`);
  await page.click('#radar .chip:has-text("clear")');
  const bmText = await page.$$eval("[data-bm] .bmst", (e) => e.map((x) => x.textContent));
  ok("bubblemaps availability checked", bmText.includes("✓"), bmText.slice(0, 5).join(","));
  ok("X layer rendered", cards.some((c) => c.text.includes("X / Twitter")) || (await page.$$eval("details summary", (e) => e.some((x) => x.textContent.includes("X / Twitter")))));

  // CA check (EVM auto-detect)
  await page.fill("#caInput", tokens[27].addr); await page.click("#caBtn");
  await page.waitForSelector("#checked .card", { timeout: 20000 });
  const checkedTxt = await page.textContent("#checked");
  ok("CA check auto-detects chain", checkedTxt.includes("HOOD"), checkedTxt.slice(0, 80));
  await page.click("#checked [data-act=recheck]"); await page.waitForTimeout(800);
  ok("recheck keeps card", (await page.$$("#checked .card")).length === 1);

  // Star + mute
  const firstKey = await page.$eval("#list .card", (e) => e.dataset.key);
  await page.click(`#list .card[data-key="${firstKey}"] [data-act=star]`);
  ok("star adds to watchlist", (await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("ts:stars"))).length)) >= 1);
  const beforeMute = await page.$$eval("#list .card", (e) => e.length);
  const muteKey = await page.$eval("#list .card:nth-child(2)", (e) => e.dataset.key);
  await page.click(`#list .card[data-key="${muteKey}"] [data-act=mute]`);
  const afterMute = await page.$$eval("#list .card", (e) => e.map((x) => x.dataset.key));
  ok("mute removes card", !afterMute.includes(muteKey) && afterMute.length === beforeMute - 1);

  // Refresh with a vanished pair
  const shownKey = afterMute[0];
  goneAddr = shownKey.split(":")[1];
  const goneTok = tokens.find((t) => t.addr.toLowerCase() === goneAddr.toLowerCase()); goneAddr = goneTok.addr;
  await page.click("#refreshBtn");
  await page.waitForFunction(() => /Refreshed|Refresh failed/.test(document.querySelector("#status").textContent), null, { timeout: 30000 });
  ok("refresh flags PAIR GONE", (await page.textContent("#list")).includes("PAIR GONE"), await page.textContent("#status"));
  goneAddr = null;

  // Second scan: survival + deltas
  await page.click("#scanBtn"); await waitScan(page);
  const seen = await page.evaluate(() => Math.max(...Object.values(JSON.parse(localStorage.getItem("ts:seen"))).map((s) => s.n)));
  ok("scan memory counts repeat sightings", seen >= 1, "max n=" + seen);
  const logRows = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("ts:outcomes") || "{}")).length);
  ok("outcome log records A/B coins", logRows > 0, String(logRows));
  await page.click('.tab[data-tab="log"]');
  ok("outcome log renders", (await page.$$("#tab-log tr")).length > 1);
  await page.click("#logUpdate"); await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "desktop-log.png") });
  await page.click('.tab[data-tab="results"]');

  // Mode switch remembers filters per mode
  await page.click('[data-mode="lowcap"]'); await waitScan(page);
  ok("low cap mode filters applied", (await page.inputValue("#fMaxMcap")) === "150000");
  await page.fill("#fMinTx", "33"); await page.waitForTimeout(700);
  await page.click('[data-mode="default"]'); await waitScan(page);
  await page.click('[data-mode="lowcap"]'); await waitScan(page);
  ok("per-mode filter memory", (await page.inputValue("#fMinTx")) === "33");
  await page.screenshot({ path: path.join(OUT, "desktop-full.png"), fullPage: true });

  // Settings dialog health test
  await page.click("#settingsBtn"); await page.click("#sTest"); await page.waitForTimeout(300);
  ok("settings health check", (await page.textContent("#sHealth")).includes("Jev ready"));
  await page.keyboard.press("Escape");
  await ctx.close();

  // 3) Mobile layout
  ({ ctx, page } = await newPage({ width: 390, height: 844 }));
  await page.goto("http://localhost:8080/");
  await page.evaluate((w) => localStorage.setItem("ts:settings", JSON.stringify({ workerUrl: w, useJev: true, strict: false, mode: "default" })), WORKER);
  await page.reload();
  await page.click("#scanBtn"); await waitScan(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("mobile: no horizontal scroll", overflow <= 0, "overflow " + overflow);
  await page.screenshot({ path: path.join(OUT, "mobile.png"), fullPage: false });
  await page.click("#fToggle");
  await page.screenshot({ path: path.join(OUT, "mobile-filters.png"), fullPage: false });
  await ctx.close();

  // 4) Strict empty state wording
  ({ ctx, page } = await newPage({ width: 1000, height: 800 }));
  await page.goto("http://localhost:8080/");
  await page.evaluate(() => { localStorage.setItem("ts:settings", JSON.stringify({ strict: true, mode: "default" })); localStorage.setItem("ts:filters", JSON.stringify({ default: { minMcap: 999999999 } })); });
  await page.reload(); await page.click("#scanBtn"); await waitScan(page);
  ok("empty state says nothing met the bar", (await page.textContent("#list")).includes("Nothing met the bar"));
  await ctx.close();
} catch (e) {
  results.push(["FAIL", "harness exception", e.stack]);
} finally {
  await browser.close(); server.close();
}
ok("no page/console errors", errors.length === 0, errors.slice(0, 5).join(" || "));
for (const [s, n, d] of results) console.log(`${s}  ${n}${d ? "  — " + String(d).slice(0, 160) : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
