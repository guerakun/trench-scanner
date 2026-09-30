// Jev question set. Lives in the Worker (not the page) so the Worker can't be
// used as a general-purpose proxy for the API key. The page sends only the
// prepared evidence ("state") for each coin; every question below is asked
// against that state in ONE request, so they run in parallel.
//
// Bump QUESTIONS_VERSION whenever wording changes, so cached answers expire.

export const QUESTIONS_VERSION = "2026-09-30.1";

export const QUESTIONS = {
  verdict: {
    type: "choice",
    instructions: {
      task: "Give this token's security verdict.",
      use_only: "Use only the security evidence: `security` (checker findings, risk list, honeypot, taxes, mint/freeze/pause flags), `holders` (concentration, insiders, creator history) and `liquidity` (LP lock and depth). Ignore price action, hype and story.",
      missing_data: "A missing or failed check counts against safety, never for it."
    },
    criteria: {
      PASS: "No material security risk found: not a honeypot, taxes at or below 5%, mint and freeze disabled or not applicable, LP locked or burned or held by a validated bonding curve, and no dominant holder or insider cluster.",
      CAUTION: "Some risk flags (moderate holder concentration, partly unlocked LP, elevated but not extreme taxes, warn-level checker risks, mutable metadata, serial deployer), but nothing that directly enables theft or blocks selling.",
      FAIL: "At least one serious risk: honeypot or cannot sell, sell tax above 10%, active mint or freeze authority, owner can change balances, danger-level checker risks, a single holder or insider cluster controlling a large share, LP mostly unlocked on a small pool, or already rugged."
    }
  },

  grade: {
    type: "choice",
    instructions: {
      task: "Grade how strong the EVIDENCE is that this memecoin is a safer, better-structured launch than its peers. This ranks evidence. It is not a price prediction and not a buy rating.",
      weighting: "Weight risk evidence about 80%: security 35, holder research 25, exit depth (liquidity versus market cap, LP lock) 15, structural validation (bonding curve or pair validated, data consistent) 5. Weight activity about 20%: when `coin.stage` is young, weight story and volume; when it is older, weight crowd trend and volume.",
      evidence: "`rules.pillars` holds points per pillar computed by code and `rules.grade` is the rules-only grade. Treat them as evidence alongside the raw fields and depart from them when the raw evidence clearly disagrees.",
      missing_data: "Unknown or missing security data lowers the grade. It never raises it."
    },
    criteria: {
      A: "Strong evidence across the risk pillars: clean security, holders spread out with no insider cluster, deep and locked exit liquidity, validated structure, and real activity.",
      B: "Mostly clean with minor gaps or one moderate weakness, and activity is present.",
      C: "Mixed: a notable weakness in one risk pillar, or thin evidence overall.",
      D: "Several weaknesses, or one risk pillar that clearly fails.",
      F: "Security failure or overwhelming red flags."
    }
  },

  phase: {
    type: "choice",
    instructions: "Which lifecycle phase best describes this coin right now? Use `coin.ageHours`, `market.priceChange`, `market.volume` and `crowd`.",
    criteria: {
      EARLY: "Newly launched or pre-breakout: little price extension yet and activity only starting.",
      RUNNING: "In an active move: price rising with growing trade counts, not yet stretched.",
      EXTENDED: "Stretched after a large run: big multi-hour gains while momentum fades or sellers take over.",
      QUIET: "Low activity: few trades and a mostly flat price."
    }
  },

  heat: {
    type: "score",
    instructions: "How strong is this coin's short-term price momentum? Use `market.priceChange` (m5, h1, h6, h24) and `derived.heat`.",
    criteria: [
      "Falling hard in the recent windows",
      "Drifting down or flat",
      "Mild upward momentum",
      "Strong upward momentum across several windows",
      "Parabolic, near-vertical move"
    ]
  },

  trend: {
    type: "score",
    instructions: "How strong and healthy is crowd participation? Use `crowd`: trade counts, acceleration versus the prior window, average trade size, buy and sell mix, and unique buyers where present.",
    criteria: [
      "Dead: almost no trades",
      "Thin: few trades, or dominated by a handful of large trades",
      "Steady participation without clear growth",
      "Growing crowd: trade counts accelerating with broad participation",
      "Surging broad crowd with many small and mid-size trades"
    ]
  },

  lore: {
    type: "score",
    instructions: "How deep and original is this coin's story, social presence and branding? Use `story` (description, links, image, banner) and `x` when present. Judge substance and distinctiveness, not hype words.",
    criteria: [
      "No story: no description and no socials",
      "Minimal: a ticker plus a generic line or a single link",
      "Basic: a clear concept with a couple of working socials",
      "Solid: a coherent narrative, several socials and consistent branding",
      "Distinctive: original, well-developed lore with an active community presence"
    ]
  },

  gap: {
    type: "choice",
    instructions: "Compare the attention this coin is getting (`derived.attention`: boosts, profile, socials, trade counts, X mentions) with how much is already priced in (`market.marketCap` and `derived.pricedIn`).",
    criteria: {
      attention_ahead: "Attention clearly exceeds what the market cap reflects.",
      balanced: "Attention and market cap roughly match.",
      priced_in: "Market cap is high relative to the attention visible.",
      not_enough_evidence: "Too little attention data to judge."
    }
  },

  rebound: {
    type: "noul",
    instructions: "Does the price action show a rebound shape: a large drawdown over the longer windows (`market.priceChange.h24` or `h6` strongly negative) followed by recovery in the most recent windows (h1 and m5 positive) with buyers returning in `crowd`?"
  },

  setup: {
    type: "noul",
    instructions: "Does this coin show a pre-run setup pattern: price consolidating in a tight range (small h1 and h6 changes in `market.priceChange`) while trade counts and buy share in `crowd` rise and liquidity holds steady?"
  },

  narrative: {
    type: "choice",
    instructions: "What is this coin's narrative category? Use `coin.name`, `coin.symbol`, `story.description` and `x` when present. Judge what the coin is about, not whether it is good.",
    criteria: {
      ai_tech: "AI, agents, robots or a technology theme.",
      animal_pet: "An animal or pet character.",
      political_news: "Politics, politicians or a news event.",
      celebrity_influencer: "A celebrity, streamer or influencer.",
      internet_meme_culture: "An internet meme, joke or cultural reference.",
      crypto_native: "A joke or theme about crypto itself, a chain, an exchange or a platform.",
      real_world_assets: "Stocks, commodities or real-world assets.",
      community_takeover: "A revival or takeover of an older coin by its community.",
      utility_claim: "Claims a product, app, game or utility.",
      other: "A clear theme that fits none of the above.",
      not_enough_evidence: "Too little information to tell what it is about."
    }
  },

  bot_chatter: {
    type: "choice",
    instructions: "Judge the X/Twitter chatter about this coin from `x`: tweets that mention the contract address, author follower counts and account ages, the share of duplicate text, and how many distinct accounts mention the ticker.",
    criteria: {
      organic: "Varied real accounts posting different things.",
      mixed: "Some real accounts mixed with obvious low-quality or copy-paste posts.",
      bot_or_paid: "Mostly new or tiny accounts, duplicated text, or coordinated shilling.",
      silence: "Almost nobody is posting about it.",
      not_enough_evidence: "No X data was provided."
    }
  }
};

// Thesis: the page finds candidate sentences in the coin's own description and X posts;
// Jev only SELECTS the one that best states what the coin is about (it never writes text).
const CAND_ID = /^[a-z0-9_]{1,8}$/;
export function thesisQuestion(candidates) {
  if (!Array.isArray(candidates)) return null;
  const criteria = {};
  for (const c of candidates.slice(0, 9)) {
    if (!c || !CAND_ID.test(String(c.id)) || typeof c.text !== "string") continue;
    const text = c.text.trim().slice(0, 240);
    if (text.length >= 8) criteria[c.id] = text;
  }
  if (!Object.keys(criteria).length) return null;
  criteria.none = "None of these sentences explains what the coin is about.";
  return {
    type: "choice",
    instructions: "Which sentence best states this coin's thesis: what the coin is about and why it exists, in the project's or community's own words? Prefer a specific, concrete sentence over hype, price talk, or calls to buy. Use `coin` and `story` for context.",
    criteria,
  };
}

// Builds the questions for one coin and strips the candidate list out of the state.
export function questionsFor(state) {
  const qs = { ...QUESTIONS };
  let clean = state;
  if (state && typeof state === "object" && state.thesisCandidates) {
    const tq = thesisQuestion(state.thesisCandidates);
    if (tq) qs.thesis = tq;
    clean = { ...state };
    delete clean.thesisCandidates;
  }
  return { questions: qs, state: clean };
}

// Compact schema the page can display without knowing the wording.
export function schema() {
  const out = {};
  for (const [id, q] of Object.entries(QUESTIONS)) {
    out[id] = { type: q.type };
    if (q.type === "choice") out[id].options = Object.keys(q.criteria);
    if (q.type === "score") out[id].levels = q.criteria;
  }
  return { version: QUESTIONS_VERSION, questions: out };
}
