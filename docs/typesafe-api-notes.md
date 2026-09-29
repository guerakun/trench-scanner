# TypeSafe / Jev API notes

Gathered 2026-09-29 from docs.typesafe.ai (api.md, primitives.md, patterns/composite-scoring.md).
These are summaries; the live docs are the source of truth.

## Endpoint

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

Request body:

```json
{
  "model": "jev-latest",
  "state": { "...": "string | object | array" },
  "questions": { "<id>": { "type": "...", "instructions": "...", "criteria": "..." } }
}
```

Question IDs are for code only and are not sent to the model, so each question's
instructions must carry their full meaning. Reference nested state with backticked
paths, e.g. `coin.socials.twitter`.

## Primitives

| Type | Use for | criteria | Answer fields |
| --- | --- | --- | --- |
| `noul` | Is this true? | optional `{ "true": "...", "false": "..." }` | `noul` (0-1) |
| `choice` | One of a set (max 255 options) | `{ "key": "description" \| null }` | `choice`, `probabilities`, `confidence` |
| `score` | Position on ordered levels (2-10) | `["level 0", "level 1", ...]` | `score`, `legend`, `probabilities`, `confidence` |

Response:

```json
{
  "model": "...",
  "answers": { "<id>": { "type": "score", "score": 0.0, "legend": {}, "probabilities": {}, "confidence": 0.0 } },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

## Errors

| Code | Meaning |
| --- | --- |
| 401 | Missing or invalid API key |
| 422 | Request validation failed |
| 429 | Rate limited, back off exponentially |
| 529 | Overloaded, retry after a delay |

## Guidance worth keeping (from SKILL.md)

- Send every question about the same state in one request; they run in parallel.
- One narrow judgment per question. Keep arithmetic, thresholds and exact lookups in code.
- Include a no-match / "not enough evidence" outcome.
- A Noul near 0.5 means "can't tell", not "medium".
- Confidence measures how concentrated the distribution is, not permission to act.
- Typed output guarantees the interface, not the truth. Validate in the target domain.
- Keep API credentials server-side in web apps.
