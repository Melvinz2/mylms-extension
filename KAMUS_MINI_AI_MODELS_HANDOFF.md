# Handoff for Kamus Mini AI model selection

The dashboard exposes model selection and explains AI limits in the
account's search result. This document defines the follow-up work for the
extension repository (implemented in this repo on branch
`codex/extension-v2-client`); no extension source is included in the
dashboard repository.

## Dashboard API

- `GET /api/v1/ai-models/available` — models visible to the authenticated
  account, safe display name, capability and availability only. Never return
  provider URLs, credentials or internal model settings.
- `PUT /api/v1/ai-models/preference` with `{ "modelId": "<catalog-id>" }` —
  store the account's selected model. Reject disabled, hidden or unknown models.
- `GET /api/v1/agent/my-ai-usage` — effective request rate, requests remaining
  in the rolling minute, concurrent requests in use, daily quota remaining and
  next WIB reset.
- `POST /api/v1/agent/search-answer` accepts optional `modelId`. Resolution is
  explicit model, account preference, then admin default. The server validates
  the model against its catalog and uses provider configuration kept server-side.
- `POST /api/search` accepts the same optional `modelId` beside `query`.
  Screenshot lookup `/api/v1/agent/search-answer-image` accepts it as an optional
  multipart form field beside `image`. Omit it to use the saved account preference.

## Extension follow-up

1. Add a model selector to extension settings using the authenticated model
   catalog. Keep the selected catalog ID with the existing account credentials.
2. Send `modelId` on lookup. During dashboard-first rollout, if the extension
   version lacks this field, the server uses the saved account preference.
3. Send `X-AI-Client-Version: 2` on lookup requests and handle structured HTTP
   429 responses for rolling request limits, concurrent requests, daily account
   quota or provider throttling. HTTP 503 means the selected model/provider is
   unavailable. Read `reasonCode`, not the human-readable message, to distinguish them.
4. When `retryAfterSeconds` is provided, show a countdown and allow retry when
   it expires. Do not retry indefinitely or silently select another model.
5. Continue showing a successful database answer even when the account's AI
   fallback is limited. Database lookup does not consume fallback quota.
6. Display the model used in successful AI answers. Never display endpoint URLs,
   provider API keys, or raw server secrets.

## Compatibility checks

- Old extension request without `modelId` resolves the saved account preference.
- Unknown, disabled or hidden IDs never reach a provider.
- HTTP 429 is retriable only after the server-provided delay; non-rate-limit
  errors keep their existing handling.
- Database HIT remains available during every AI limit state.
- Switching model or API key does not reset account-level limits.

## Response examples

Available choices are returned as `{ "success": true, "data": { "models": [],
"selectedModelId": null } }`. Each model contains `id`, `displayName`,
`supportsImages`, `enabled`, `visibleToUsers`, `isDefault`, and `sortOrder`.
If a previously selected model is no longer in the returned list, keep its ID
as unavailable until the user explicitly chooses another model. Do not silently
choose the first list entry.

```json
{
  "matchScore": 0,
  "answer": "Batas permintaan AI per menit tercapai. Tunggu sebelum mencoba lagi.",
  "reasonCode": "RATE_LIMIT",
  "retryAfterSeconds": 12
}
```

Read `Retry-After` when supplied. Countdown values for provider/concurrency
limits are estimates, not a guarantee that provider capacity will be available.
Daily limits use the WIB reset shown by `data.quota.nextResetAt` in
`GET /api/v1/agent/my-ai-usage`.

The same usage endpoint returns `requestsPerMinute`, `remainingThisMinute`,
`concurrentLimit`, `activeRequests`, and `quota`. Poll sparingly while the popup
is open and refresh after a lookup; stop polling when the popup closes.

Existing search response names (`answer` versus quick-search `jawaban`) remain
endpoint-specific. Preserve those contracts. The original HTTP 404 behavior
remains for clients that do not send the v2 header; added `reasonCode` and
`retryAfterSeconds` allow gradual extension adoption.

See [catalog and analytics API](AI_CATALOG_ANALYTICS_API.md) for admin-only
routes, source-backed draft review, and generated OpenAPI registration.
