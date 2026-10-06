# How Jev decides (as built)

Roles, as Faisal set them:

| Who | Job |
| --- | --- |
| The page (Claude-built code) | Gathers and prepares evidence: discovery, market data, RugCheck/GoPlus, pump.fun curve reads, holders, crowd stats, X data, and a rules-based score for every pillar |
| **Jev** (TypeSafe, via the Worker) | **The decision engine.** Returns the verdict, the A–F grade, the phase, and the category reads (heat, trend, lore, gap, rebound, setup, X chatter), each with probabilities |
| Tie-break + caps (explicit code) | Settles close calls and enforces the hard rules |

## Flow per scan

1. Coins that meet the filters get security checks, curve reads and rules-based evidence.
2. Coins that aren't a rules-level security FAIL (up to *Jev coins per scan*, default 40, ranked by evidence) go to Jev in batches of 10. The optional X data is fetched first so Jev can see it.
3. One Jev request per coin asks all 10 questions in parallel (`worker/src/questions.js`).
4. The page applies `decide()`:

### Grade
- Jev's top grade wins when it leads by at least **10 points** and is at least **30%** likely.
- **Tie** (exactly two grades within 10 points, e.g. A 35% / B 35%): pick the tied grade closest to the rules-evidence grade. If still even, take the **lower** grade.
- **Jev unsure**: top grade under 30%, or a three-way split within 10 points (e.g. B 30% / C 26% / A 23%). Take the more cautious of Jev's top pick and the rules grade.
- Jev chose a grade but sent no probabilities → the more cautious of Jev's pick and the rules grade.
- Jev's grade unreadable → rules-only, and the card says so.
- Probabilities are compared as whole percentage points, so "within 10 points" means a gap of 9 or less.
- Every card shows Jev's probabilities and says in words when a tie-break or the unsure rule decided it.

### Verdict
- No security checker data → **UNKNOWN**, whatever Jev says (never a fake pass).
- Tie between verdicts → the stricter one.
- Jev's verdict unreadable → the rules verdict is used, and the card says so.
- Hard failures always force **FAIL**: rugged, honeypot, cannot buy or sell, sell tax > 10%, active mint or freeze authority, owner can change balances, hidden owner, can take back ownership, self-destruct, creator made honeypots before.

### Caps applied after Jev (code, not negotiable)
- Verdict FAIL → grade at most D.
- Capped at C: unknown verdict; thin or unlocked LP on a coin under 24h; duplicate ticker (deepest-liquidity CA across the whole scan keeps the name); serial deployer (5+ prior launches); bonding curve not validated (four.meme curves can't be read yet, so they always hit this cap); RugCheck summary-only data; 10% or more of the supply in lock vaults; one unlocked wallet holding 10% or more (pools, curves, burn addresses and vaults excluded).

### Phase
- Tie between phases → the rules-based phase if it's one of the tied options.

### Thesis and narrative
- The page pulls candidate sentences from the coin's own description (up to 6) and from X posts that mention the contract (up to 3), dropping addresses, links and bare "buy/ape" posts.
- Jev **selects** the sentence that best states what the coin is about (or "none"). It never writes or paraphrases, so the card always quotes real words, labeled with their source and "unverified claim".
- Jev also picks a narrative category (AI/tech, animal, politics/news, celebrity, meme culture, crypto-native, real-world assets, community takeover, utility claim, other).
- Without a Jev pick, the card shows the description's first usable line and says so.
- The thesis is context only. It does not change the grade.

### What we found
Plain sentences built by code from data already gathered (holder concentration, biggest wallet, creator holdings and prior launches, insider networks, LP lock or curve progress, taxes and authorities), each marked green, amber, red or neutral. Raw numbers stay in the dropdowns.

### Lock vaults
- RugCheck labels lock and vesting vaults (for example Streamflow) among the top holders. The scanner keeps them out of the "top 10 wallets" figure but reports them as their own finding, counts them as concentration in the Holders pillar, and passes them to Jev as `holders.lockVaults`.
- For Streamflow vaults the page reads the lock contract through the free Solana RPC (three calls per vault, cached 24h): who is paid, when it unlocks or vests, and whether the sender can cancel. The contract is only trusted if its mint and vault address match the coin.
- Other lockers, and EVM lockers reported by GoPlus, show "terms unknown".
- 10% or more of the supply in lock vaults caps the grade at C, whatever the terms.
- A vault finding is red when tokens are claimable now, the first unlock is within 7 days, or the sender can cancel.

### When Jev is unavailable
No Worker, Jev turned off, or an error → the card says **Rules-only** and why. Nothing is silently faked.

## Cost
About $0.042 per million input tokens and output is free. At ~2K tokens of evidence × 10 questions for 40 coins, one scan should cost a few cents at most (verify against your TypeSafe usage page). The page skips coins whose evidence hasn't meaningfully changed in the last 10 minutes. The Worker also caches identical requests for an hour, but live coins change every scan, so expect that cache to hit rarely.

## Guarding your key
The Worker only asks the fixed questions in `worker/src/questions.js`, only answers pages on the allowed origins, and rate-limits `/jev` and `/x` to 30 requests a minute per IP. The Origin check can be faked outside a browser, so it's worth setting a spending limit in your TypeSafe account too.
