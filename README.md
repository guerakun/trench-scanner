# Trench Scanner

A single-file memecoin launch screener (`index.html`, no build step, dark theme,
mobile-friendly) that screens coins for **evidence and safety, not buy signals**.
It will be hosted on GitHub Pages.

> Grades rank evidence. They are not predictions. An A-grade memecoin is still a lottery ticket.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole screener: one file, no build step, no keys |
| `worker/` | Cloudflare Worker that holds your keys and runs Jev, the optional X layer, and a read-only data relay |
| `test/` | Offline Worker test and a full end-to-end browser test with every API mocked |
| `SKILL.md` | Local copy of the TypeSafe skill (typesafe-ai/skills, MIT) |
| `docs/typesafe-api-notes.md` | API notes gathered from docs.typesafe.ai |
| `docs/jev-integration-plan.md` | How Jev decides, how ties are broken, which caps apply |
| `.env.example` | Keys the Worker needs; copy to `.env` |

## Secrets

API keys never go in `index.html` or in git. Put them in `.env` (git-ignored) on your
machine, then upload each one to the Worker as a secret:

```
cd worker
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put TWITTERAPI_IO_KEY
```

The page only knows the Worker's URL, which you paste into its settings panel.

## How it decides

The page gathers and prepares evidence. **Jev is the decision engine**: it returns the verdict,
the grade and the category reads with probabilities. When Jev's top two answers are within
10 points (say A 35% / B 35%), the page breaks the tie with the rules-based evidence and, if that's
still even, takes the more cautious answer. Hard security failures and the cap-at-C rules are
always enforced by code. See `docs/jev-integration-plan.md`.

Without a Worker the screener still works, labeled **rules-only** on every card.

## Run the tests

```
node worker/test/worker.test.mjs      # Worker logic, network mocked
node test/browser.test.mjs            # real Chromium, all APIs mocked (needs Playwright)
```
