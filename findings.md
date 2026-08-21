# Investigation Brief for a New Agent

Investigate the best method to implement a "best value for money among inference providers, taking throughput into account" feature for the DeepSeek Harness desktop LLM settings UI. The feature ships as a widget in the model-settings screen (package `packages/client/ui-settings-models`), backed by a new host RPC in `packages/host/apiproxy`. See the full design context in [docs/superpowers/specs/2026-08-18-openrouter-provider-value-design.md].

Your task, in order:

1. Re-verify the OpenRouter API surface below against the live endpoints (they change: the first candidate endpoint 404'd, and per-provider privacy data is only in server-rendered HTML, not any public JSON API).
2. Decide the best source for each data field the feature needs:
   - per-provider input/output/cache-read price (per-1M-token USD, incl. fractional `discount`),
   - per-provider throughput (tokens/s) and latency — **these are `null` without an OpenRouter API key**,
   - per-provider uptime (`uptime_last_1d/30m/5m`),
   - per-provider implicit-cache support and quantization,
   - per-provider "does not train on prompts / does not retain prompt data" privacy flag — the green `Privacy: Private` shield. **No public OpenRouter endpoint exposes it** as of now; it exists only in the model page's server-rendered data as `aria-label="Privacy: Private"` next to the provider name.
3. If you find a first-party API that exposes the privacy/training flag per provider, recommend it over scraping the HTML. If not, confirm the scrape approach from [docs/superpowers/specs/2026-08-18-openrouter-provider-value-design.md] and specify a robust selector for the provider-name → privacy-badge mapping.
4. Propose the exact RPC contract (request/response fields), the score formula (generation-seconds-per-dollar = tokens-per-second ÷ blended per-token price, three cache-hit bands, balanced input/output split), and the host handler shape that matches the existing `llm.discoverModels` pattern in `packages/host/apiproxy/src/api-proxy.ts` (see provenance below).
5. Return a written recommendation with: chosen data sources (URLs + verified sample), the RPC wire contract, the score formula, error taxonomy, and a test plan consistent with this repo's gates (`pnpm run test:coverage` 100% per file, snapshot tests under `apps/web/tests/snapshots/models-settings/`, key-gated `test:e2e`). Record your own investigation findings in `findings.md` below the `## Investigation Log` heading.

Verified facts to start from are in the Investigation Log below. Treat every number there as a snapshot to re-check, not as truth.

---

# Investigation Log

**Date:** 2026-08-18
**Purpose:** Investigate the OpenRouter data surface for a "best value for money among inference providers, considering throughput" widget in the DeepSeek Harness desktop model-settings UI. The widget ranks the providers that host one OpenRouter model (the reference model is `deepseek/deepseek-v4-flash-0731`) by price, throughput, uptime, caching, and a configurable "does not train on prompts" filter.

## 1. The feature (approved design, abbreviated)

- **UI widget** in `packages/client/ui-settings-models` (`ModelsSection.tsx` / `ProviderEditor.tsx` WIP surface), next to the provider editors, showing a ranked provider table with a winner badge.
- **New RPC** `llm.providerValue` on the `llm:` domain of `packages/host/apiproxy` (request model id + uptime floor + training filter; response = ranked rows). The host holds the OpenRouter API key; the client never sees it.
- **Score:** generation-seconds-per-dollar = `throughput_p50 ÷ blendedPerTokenPrice`, where `blendedPrice(hit) = 0.5·(hit·cacheRead + (1−hit)·prompt) + 0.5·completion`. Three cache-hit bands: 0% (no cache), 50% (typical), 95% (cache-efficient). Winner = max score at the 50% band.
- **Privacy:** an optional "no-training-only" toggle filtering to providers whose page badge reads `Privacy: Private`. There is no public API source for this flag (see §4).

## 2. OpenRouter data sources, verified

### Model page (human reference)
- `https://openrouter.ai/deepseek/deepseek-v4-flash-0731#providers` — the "Providers" tab table gives, per provider: input / output / cache-read price, latency (s), throughput (tps), uptime (%). Values like: StreamLake $0.0786/$0.1572/$0.01572 @ 39 tps; CoreWeave $0.13/$0.28/$0.07 @ 80 tps, 99.83% uptime; Wafer Fast $0.28/$0.56/$0.07 @ 195 tps (fastest shown); cloud-scale aggregate throughput 195 tps, latency 0.65 s best.
- Reference model facts: DeepSeek V4 Flash 0731, 13 B active / 284 B total MoE, 1 M context, $0.0786/$0.1572 list, released 2026-07-31.

### Primary API — List endpoints for a model
- **Endpoint:** `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints` (documented at `https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints`). The `data.endpoints[]` array is per provider.
- Sample field set (keys union, verified on the live response for `deepseek/deepseek-v4-flash-0731`, 28 endpoints):

| field | note |
|---|---|
| `pricing.prompt` / `pricing.completion` / `pricing.input_cache_read` | USD **per token** (strings; ×1e6 for per-1M views) |
| `pricing.discount` | fractional (e.g. `0.4386`); list price already reflects it |
| `pricing.request` | per-request fee, often absent |
| `throughput_last_30m` (p50/p75/p90/p99) | tokens/s; **`null` without a valid API key** ("Only visible when authenticated with an API key or cookie") |
| `latency_last_30m` (p50…) | seconds to first token; **also key-gated, `null` unauthenticated** |
| `uptime_last_1d` / `uptime_last_30m` / `uptime_last_5m` | % successful requests, excludes rate-limited |
| `status` | endpoint status enum; observed `0` (22 of 28 active), `-2` (5), `-5` (1) |
| `supports_implicit_caching` | boolean |
| `quantization` | `fp8` observed; enum incl. int4/int8/fp*/bf16/fp32 |
| `provider_name`, `model_id`, `model_name`, `tag` | identity |
| `context_length`, `max_prompt_tokens`, `max_completion_tokens` | capacity |
| `supports_voice_cloning` | present, always false for this model |

- **Responses we ran and learned from:**
  - `GET /api/v1/endpoints` → `404 {"error":{"message":"Not Found"}}` (two shapes tried, incl. `No-Cache` header).
  - `GET /api/v1/models/deepseek/deepseek-v4-flash-0731?include_endpoints=true` → 404.
  - `GET /api/v1/models/deepseek/{permaslug}/endpoints` → 200; both slugs (`0731` and `20260731`) resolve for this model.
  - `GET /api/v1/models/deepseek:deepseek-v4-flash-0731/endpoints` (old colon syntax) → 404.
  - `GET /api/v1/models/{author}/{slug}/route` → 404 (also with `?providers=turbo`, `?fetch=1`). The old `provider_route.provider_data_rank` privacy-ranked list is **no longer publicly available**.
  - `GET /api/v1/models/{author}/{slug}/providers` → 404.

### Model list
- `GET https://openrouter.ai/api/v1/models` (no auth) → 413 models. Per-model `data_policy` was **`null` for every model** checked (the model-level "training" flag is no longer populated).

### Provider directory
- `GET https://openrouter.ai/api/v1/providers` (no auth) → 102 providers. Fields: `name`, `slug`, `privacy_policy_url`, `terms_of_service_url`, `status_page_url`, `headquarters`, `datacenters`. **No per-provider training/data-policy flag.** Useful for privacy-policy links, nothing else.

## 3. Where the "Private" shield actually comes from

- The model page (Next.js, server-rendered) embeds per-provider `provider_info.dataPolicy`:

```json
{
  "training": false,
  "trainingOpenRouter": false,
  "retainsPrompts": true,
  "canPublish": false,
  "termsOfServiceURL": "https://...",
  "privacyPolicyURL": "https://...",
  "requiresUserIDs": false
}
```

- The green shield is rendered in the providers table as `<span role="img" aria-label="Privacy: Private" class="inline-flex shrink-0 cursor-help items-center text-positive-text">…<svg … lucide-shield-check …>` immediately after the provider's name `<span class="truncate text-xs text-foreground">DeepInfra</span></button>`.
- The string `api/gateway/v1/endpoints` present in the page HTML is a **red herring**: it is a provider's own base URL (`https://vanchin.streamlake.ai/api/gateway/v1/endpoints` under `provider_info.baseUrl`), not an OpenRouter API path. `GET https://openrouter.ai/api/gateway/v1/endpoints` returns HTML, not JSON.
- The Shield's meaning ("does not train on prompts and does not retain prompt data") corresponds to `retainsPrompts: false` (with `training` context). Exact condition to confirm against the page's tooltip semantics during implementation.
- **This data is not exposed by any public endpoint** we tried (`/models`, `/models/{author}/{slug}/endpoints`, `/providers`, `/route`). The approved design therefore scrapes the model page for the `aria-label="Privacy: Private"` badge, per provider name, with a graceful fallback to `privacy: 'unknown'`.

## 4. Repository context (how the feature mounts)

- `packages/host/apiproxy/src/api-proxy.ts` hosts the `llm:` RPC domain (`providers`, `models`, `discoverModels`, `startOAuthLogin`) at ~line 3370. Handlers delegate to `ctx.llm`; the OAuth handler shows the credential-store access pattern: `ctx.get('credentials')` then `credentials.oauthStore.modify(...)` (~line 3438).
- RPC contract shape for a new domain method:
  - `packages/host/apiproxy/src/api/llm.ts` — wire view interfaces + `LlmApi` method JSDoc.
  - `packages/host/apiproxy/src/api/llm.schema.ts` — zod schemas named `llm<Method>RequestSchema` / `llm<Method>ValueSchema`.
  - `packages/host/apiproxy/src/api/rpc-map.ts` and `src/api-proxy.ts` — registration.
  - `packages/host/apiproxy/src/fetch/client.ts` — client-side callable.
  - Compiler faces: `packages/host/apiproxy/src/api/index.ts` `llm: LlmApi`.
- Precedent for an OpenRouter-backed network plugin in this repo: `docs/superpowers/specs/2026-08-16-openrouter-web-search-design.md` — a dedicated package owns the OpenRouter HTTP call and resolves the key via the credentials service with launch-env fallback; key never enters settings, session events, or error messages.
- WIP on the working branch (uncommitted, touches this surface): `apps/desktop/src/main.ts`, `apps/web/tests/snapshots/models-settings/*`, `packages/client/connection/src/client/fixture.ts`, `packages/client/ui-settings-models/…` (`ModelsSection.tsx`, `ProviderEditor.tsx`, `ModelsSection.module.css`, `locales.ts`), `packages/credentials/*`, `packages/host/apiproxy/src/*` (`api-proxy.ts`, `api/llm.schema.ts`, `api/llm.ts`, `api/rpc-map.ts`, `fetch/client.ts`, `fetch/handler.ts`), `packages/llm/llm-pi-ai/*` (OpenRouter is a `thinking-format` in the pi-ai catalog), `packages/llm/llm/*`, `packages/llm/llm-gemini/*`.
- Serving this feature inside existing packages avoids a new package/invariant; the widget has no Cordis-service reason to exist, so a host RPC handler + client component (approach A, approved) beats a new capability plugin (approach C).

## 5. Decisions and open questions

Decisions made (approved):
- Approach A: host RPC `llm.providerValue`; widget in `ui-settings-models`; key stays on host.
- Score = generation-seconds-per-dollar at three cache bands (0/50/95%), in/out split 0.5/0.5 (constants, documented), winner at the 50% band.
- Uptime floor default 95% — dim below, don't drop.
- `trainFilter` default `'all'`; when `'private'`, scrape the page and, on any failure, degrade to `privacy: 'unknown'` rather than failing the query.
- Non-fatal scrape failure surfaces an amber "privacy flags unverified" note.
- Error taxonomy: `provider-value-failed` (network/non-2xx), `provider-value-credential-missing` (no key), client-side rejection for malformed `modelId`.

Open questions / risks to re-check:
- Whether OpenRouter has since published a per-provider privacy/training flag through a first-party API (the investigation recipe in §2 is rerunnable).
- `status` semantics (`-2`, `-5`) and whether `-2` entries should be considered routable.
- Cache-hit band values: 50% "typical" is an assumption; OpenRouter's pricing page publishes "average price actually paid" which could calibrate it later.
- `discount` is reflected in the list price, but a provider may quote a non-discounted price with `discount` applied server-side at billing time — verify which number the UI should display.

## 6. Commands used to gather this

```bash
curl -s https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints   # 28 providers
curl -s https://openrouter.ai/api/v1/models                                              # 413 models
curl -s https://openrouter.ai/api/v1/providers                                           # 102 providers
curl -sL https://openrouter.ai/deepseek/deepseek-v4-flash-0731                           # 1.4 MB SSR HTML; shield + dataPolicy
curl -s https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints            # openapi.yaml for ListEndpoints
```

## 7. Re-verification findings (2026-08-18)

The referenced `docs/superpowers/specs/2026-08-18-openrouter-provider-value-design.md` file is not present in this checkout; this section records the current live verification against the brief and the available `plan.md`.

### Recommendation

Use the documented model endpoint API for provider prices, performance, uptime, cache support, quantization, status, and the stable endpoint `tag`, and use the first-party ZDR endpoint list for the privacy filter. Do not ship an HTML scrape: `GET https://openrouter.ai/api/v1/endpoints/zdr` is public, returns the ZDR endpoints, and currently identifies the same 21 reference-model providers that the model page labels `Privacy: Private` when joined by `tag`.

The host should make the two OpenRouter requests, normalize and rank the result, and return only the derived rows. The browser receives no OpenRouter key. A small helper module under `packages/host/apiproxy/src/` should own URL construction, credential resolution, fetching, source validation, ZDR joining, and score calculation; `api-proxy.ts` should remain the RPC adapter in the same style as `llm.discoverModels`.

### Live API results

| Source | Live result | Use |
|---|---|---|
| `https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints` | HTTP 200, 28 endpoint rows. `pricing` values are strings per token; `discount` is fractional; `throughput_last_30m` and `latency_last_30m` are present but `null` without a key; uptime, `supports_implicit_caching`, `quantization`, `status`, and `tag` are present. | Primary source for all provider metrics and prices. |
| `https://openrouter.ai/api/v1/endpoints/zdr` | HTTP 200, 758 endpoint rows. Filtering `model_id == deepseek/deepseek-v4-flash-0731` returned 21 rows. | Primary source for the private/ZDR flag; join on `(model_id, tag)`, never on display names. |
| `https://openrouter.ai/api/v1/models` | HTTP 200, 413 models; `data_policy` was `null` for the reference model and the checked model rows. | Optional model catalog/canonical-slug lookup, not a provider-policy source. |
| `https://openrouter.ai/api/v1/providers` | HTTP 200, 102 providers; fields include policy URLs, but no training or retention flag. | Optional provider metadata only. |
| `https://openrouter.ai/api/v1/endpoints`, `.../providers`, `.../route`, and `...?include_endpoints=true` | HTTP 404 for the tested model variants. | Do not use these routes. |

The current unauthenticated sample was StreamLake: prompt `0.000000078596`, completion `0.000000157192`, cache-read `0.0000000157192`, discount `0.4386`, uptime `95.84400142040774%` over one day, `supports_implicit_caching: false`, `quantization: fp8`, and `status: 0`. The p50 throughput and latency fields were both `null`. The current response had 22 rows with status `0`, four with `-2`, and two with `-5`; OpenRouter's public endpoint documentation does not define the nonzero status meanings, so only `status === 0` should be ranked.

The environment used for this verification did not contain `OPENROUTER_API_KEY`, so authenticated non-null throughput and latency were not tested live. The host must still send `Authorization: Bearer <key>` because the official endpoint documentation requires it and documents the performance fields as authenticated data. A valid key should be resolved on the host from `ctx.get('credentials')` using `OPENROUTER_API_KEY`, with the same launch-environment fallback used by the approved OpenRouter web-search design.

The endpoint prices already include the listed discount. For StreamLake, `0.14 * (1 - 0.4386) = 0.078596` dollars per million prompt tokens, and the same multiplication yields `0.157192` completion and `0.0157192` cache-read. Multiply the API strings by `1_000_000` for the UI and do not apply `discount` a second time. One current row (`DeepSeek`) also has `pricing.overrides`; the initial widget should display and score the base prices, expose `hasPricingOverrides` if desired, and state that a single per-million value does not model token-range overrides.

### Privacy source and join

OpenRouter's current ZDR documentation defines ZDR as no provider retention and states that a provider that does not retain data cannot train on it. The reference model returned 21 ZDR rows. The model page returned 28 provider rows with 21 `Privacy: Private`, five `Privacy: Logs`, and one `Privacy: Trains` label. The 21 private rows matched the 21 ZDR rows by endpoint `tag`; display names differed in several cases (`Baseten`/`BaseTen`, `NovitaAI`/`Novita`, `Mancer`/`Mancer 2`, `io.net`/`Io Net`, and `Wafer Fast`/`Wafer`).

Therefore map `privacy: 'private'` when the endpoint's `(modelId, tag)` is present in `/api/v1/endpoints/zdr`, and map an endpoint absent from that list to `privacy: 'not-private'` only when the ZDR response was successfully loaded. If the privacy request fails or the ZDR row has no usable join key, return `privacy: 'unknown'` and a `privacy-unverified` warning for an `all` query. A `private` query must not silently return unfiltered rows; reject it with `provider-value-privacy-unavailable` or disable the filter before making the request.

HTML is a diagnostic fallback only. If a future API regression forces a temporary fallback, parse the page with an HTML parser and scope the lookup to `tr.or-table__row`: read the provider display name from `button[aria-label^="Open "] span.truncate`, then test for `[role="img"][aria-label="Privacy: Private"]` in the same row. Do not use a regex over provider names or scrape the page when the first-party ZDR source is available.

### Proposed RPC contract

Request payload:

```json
{
  "modelId": "deepseek/deepseek-v4-flash-0731",
  "uptimeFloorPct": 95,
  "trainFilter": "all"
}
```

`modelId` must be exactly `author/slug`; `uptimeFloorPct` is optional and defaults to `95`, with an inclusive range of `0` through `100`; `trainFilter` is optional and defaults to `all`, with values `all` and `private`. Keep the existing field name for the approved wire design, but document that `private` means OpenRouter ZDR/private, not every endpoint that may separately claim not to train while retaining prompts.

Response value:

```json
{
  "modelId": "deepseek/deepseek-v4-flash-0731",
  "rows": [
    {
      "tag": "coreweave/fp8",
      "provider": "CoreWeave",
      "status": 0,
      "quantization": "fp8",
      "inputPricePerMillionUsd": 0.13,
      "outputPricePerMillionUsd": 0.28,
      "cacheReadPricePerMillionUsd": 0.07,
      "discount": 0,
      "supportsImplicitCaching": false,
      "throughputP50TokensPerSecond": null,
      "latencyP50Seconds": null,
      "uptimeLast1dPct": 99.86436282760597,
      "uptimeLast30mPct": 99.71512315524245,
      "uptimeLast5mPct": 99.68119022316685,
      "privacy": "private",
      "belowUptimeFloor": false,
      "scoreNoCache": null,
      "scoreTypical": null,
      "scoreCacheEfficient": null,
      "rank": null
    }
  ],
  "warnings": []
}
```

Rows should contain only `status === 0` endpoints, because the public contract does not define `-2` or `-5` as routable. Keep `status` in each row for diagnostics. Keep rows whose one-day uptime is below the requested floor and set `belowUptimeFloor`; the floor dims the row rather than excluding it. Null throughput or latency produces null scores and rank, not zeroes. Use `tag` as the opaque join and identity field and `provider` only as display text.

The response schemas belong in `packages/host/apiproxy/src/api/llm.schema.ts`, the method and view JSDoc in `packages/host/apiproxy/src/api/llm.ts`, and the method must be added to `packages/host/apiproxy/src/api/rpc-map.ts`, `packages/host/apiproxy/src/fetch/handler.ts`, `packages/host/apiproxy/src/fetch/client.ts`, and the existing `LlmApi` face in `packages/host/apiproxy/src/api/index.ts`. The client fixtures in `packages/client/connection` and `packages/client/runtime` must implement the new method so the existing fake API contracts remain total.

### Handler and data flow

The `llm.providerValue` handler should validate the model id, resolve `OPENROUTER_API_KEY` per request, and return `provider-value-credential-missing` without making a network call when no key is available. It should then issue the model-endpoints request and, when privacy data is needed for the response or filter, the ZDR request with the caller's `AbortSignal`; parse and validate both JSON bodies before normalization; join privacy rows by `(modelId, tag)`; compute scores; and return `ok(request, { modelId, rows, warnings })`.

Map non-2xx responses, network failures, malformed JSON, missing required endpoint fields, and unsupported model responses to `provider-value-failed`. Keep `provider-value-privacy-unavailable` separate when a requested private filter cannot be enforced. Map malformed client payloads to the carrier's existing `bad-request` response, while the settings widget may reject the same invalid model id early for better inline feedback. Error details may include a safe stage, model id, and HTTP status, but never the API key or an upstream body that could contain it. Preserve cancellation rather than converting caller aborts into a retryable provider failure.

### Score calculation

Use the approved cache-hit bands `0`, `0.5`, and `0.95`, and an equal input/output token split:

```text
blendedPriceUsdPerToken(h) = 0.5 * (h * cacheRead + (1 - h) * prompt) + 0.5 * completion
valueScore(h) = throughputP50TokensPerSecond / blendedPriceUsdPerToken(h)
```

Use the endpoint's effective prices after discount, not the model-list price and not a second discount multiplication. The typical-band winner is the active row with the greatest non-null `valueScore(0.5)` after the `private` filter, if any. For an endpoint with `supports_implicit_caching: false`, the no-cache score is valid; the two nonzero bands should be marked hypothetical or returned as null rather than crediting an unavailable implicit-cache benefit.

The formula above is the requested relative ranking formula, but its name is dimensionally inaccurate: throughput divided by dollars per token is not generation-seconds per dollar. If the product keeps the formula, label the result `throughput/value score` or similar. Literal generation seconds per dollar would be `1 / (throughputP50 * blendedPriceUsdPerToken)` and would rank slower generation higher, so it is not a suitable winner metric. This should be resolved in the design review before UI copy is finalized.

### Test plan

- Add a pure host normalizer test file with full per-file coverage for valid and malformed prices, discount-without-double-application, cache bands, unsupported implicit caching, null performance metrics, one-day uptime dimming, status filtering, deterministic tie-breaking, ZDR tag joins with display-name aliases, unknown privacy, and private-filter refusal when the ZDR source fails.
- Extend `packages/host/apiproxy/tests/api-proxy-config.spec.ts` with mocked model-endpoint and ZDR responses, credential-store and environment fallback cases, exact bearer-header and URL assertions, parallel request cancellation, 401/404/429/non-2xx mapping, malformed success bodies, missing-key behavior, and secret non-disclosure in serialized errors.
- Extend the RPC carrier/client tests so `llm.providerValue` is present in the route map, request and response schemas, client callable, and every fake API implementation. Assert that the request payload is preserved and the response schema rejects nullability or unknown privacy regressions incorrectly.
- Add `packages/client/ui-settings-models` component tests for the empty, loading, credential-missing, failed, private-filter, warning, no-active-row, below-floor, null-metric, score-band, and winner states. Add the assembled keyless snapshot under `apps/web/tests/snapshots/models-settings/`; update the real settings-screen scenario rather than relying only on a jsdom component test.
- Add a key-gated `test:e2e` case that calls the live endpoint through the host, skips without `OPENROUTER_API_KEY`, and asserts at least one active normalized row and valid numeric price fields without pinning provider names, current prices, uptime, or rankings.
- Run the focused Vitest suites first, then the repository gates required by the changed surface: `pnpm run test:coverage` with 100% coverage for every touched source file, `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, the relevant assembled snapshot test, and `git diff --check`. The current investigation itself changed no source code and did not run those implementation gates.
