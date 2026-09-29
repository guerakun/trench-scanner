# Trench Scanner Worker

A small Cloudflare Worker that keeps your keys off the page:

| Endpoint | What it does |
| --- | --- |
| `GET /health` | Shows whether Jev and the X layer are configured |
| `POST /jev` | Sends each coin's prepared evidence to Jev with the fixed question set in `src/questions.js` |
| `GET /x` | Optional: who tweets the CA, `$TICKER` breadth, the official account's followers (cached 1h) |
| `GET/POST /relay` | Read-only fallback for the public data APIs if a browser call is blocked (allowlisted hosts only) |

## Deploy (Windows)

You need Node.js and a free Cloudflare account. Your keys are read from `..\.env`.

```powershell
cd C:\Projects\trench-scanner\worker
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Copy the `workers.dev` URL it prints into the screener's **Settings → Worker URL**.

If you rename the GitHub Pages site or serve it from a different domain, add that origin to
`ALLOWED_ORIGINS` in `wrangler.toml` and redeploy.

## Limits

- `/jev` and `/x` are rate-limited to 30 requests/minute per IP (the `[[ratelimits]]` block in `wrangler.toml`).
- The page sends Jev 10 coins per request, which stays inside the free plan's 50-subrequest limit even with retries.
- Setting a spending cap in your TypeSafe and twitterapi.io accounts is a good backstop.

## Why the questions live here

Keeping the Jev questions in the Worker means the Worker can only ask *these* questions,
so nobody can reuse it as a general proxy for your TypeSafe key.
