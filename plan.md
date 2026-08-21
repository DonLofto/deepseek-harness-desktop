# Plan: OpenRouter Provider Value Widget

Rank OpenRouter providers for one model by value-for-money with throughput, caching, and a "does not train on prompts" filter. Full investigation log: [findings.md](findings.md).

## 1. Findings (condensed)

Verified against live OpenRouter APIs on 2026-08-18:

- **`GET /api/v1/models/{author}/{slug}/endpoints`** is the source for per-provider data: per-token `prompt`/`completion`/`input_cache_read` prices (strings), fractional `discount`, `throughput_last_30m` (tps) and `latency_last_30m` (s-to-first-token) — **both `null` without an API key** — `uptime_last_1d/30m/5m`, `status` (`0` active, others seen `-2`, `-5`), `supports_implicit_caching`, `quantization`, `provider_name`.
- 404s tried: `/api/v1/endpoints`, `/models/{author}/{slug}/route`, `/models/{author}/{slug}/providers`, old colon slug syntax, `?include_endpoints=true`.
- **Privacy shield** (`Privacy: Private`, `retainsPrompts`/`training` in embedded `provider_info.dataPolicy`) exists **only in the model page's server-rendered HTML** as `aria-label="Privacy: Private"` next to the provider name. No public JSON endpoint exposes per-provider training status. `/api/v1/providers` (102, auth-free) offers privacy/ToS URLs only.
- `/api/v1/models` (413, auth-free) carries `data_policy` = `null` for every model.

## 2. Design

### New RPC: `llm.providerValue`

- **Request:** `{ modelId: string, uptimeFloorPct?: number, trainFilter?: 'all' | 'private' }` — client keeps cache bands; host returns raw rows + computed columns.
- **Host handler** (`api-proxy.ts` `llm:` domain):
  1. Validate `modelId` = `author/slug`; resolve OpenRouter key via `ctx.get('credentials')` → env fallback (`OPENROUTER_API_KEY`), matching `web-search-openrouter`.
  2. `GET /api/v1/models/{author}/{slug}/endpoints` with bearer key → throughput/latency populated.
  3. When `trainFilter: 'private'`, also fetch the model page HTML once and extract `aria-label="Privacy: Private"` per provider (documented-brittle; failure → `privacy: 'unknown'`, table still renders).
  4. Rank active (`status === 0`) providers.

### Score — "generation seconds per dollar"

```
blendedPrice(hit) = inFrac·(hit·cacheRead + (1−hit)·prompt) + outFrac·completion
valueSecPer$       = tps_p50 / blendedPrice        (= 1e6/(blendedPrice·1e6·tps))
```

Higher = more seconds of streaming per dollar. Winner = max in the typical (50%) band; table shows three bands per row.

**Fixed parameters (constants, documented):** in/out split `inFrac = 0.5`; cache bands `[0%, 50%, 95%]`; default `uptimeFloorPct = 95`; rows below the floor are dimmed, not dropped; `trainFilter` default `'all'`.

### Wire contract

Per-row view `ProviderValueRow`: provider, quantization, three prices (in/out/cache-read + implicit-cache badge), tps, latency, uptime, `privacy: 'private' | 'not-private' | 'unknown'`, three value columns, rank. Zod schemas named `llmProviderValueRequestSchema` / `llmProviderValueValueSchema` in `api/llm.schema.ts`; `LlmApi` JSDoc in `api/llm.ts`; registration in `api/rpc-map.ts` + `api-proxy.ts` + `fetch/client.ts` (`api/index.ts` `llm: LlmApi`), same mechanics as `llm.discoverModels`.

## 3. UI (in `packages/client/ui-settings-models`)

- Model-id input, default = current session model; Enter/blur triggers fetch.
- Uptime-floor slider (95–100) + "no-training-only" switch.
- Ranked table: winner ★ in typical band; columns provider (+ shield glyph when `private`, tooltip), in/out/cache-read $ per 1M, implicit-cache dot, tps (P50), latency, uptime, value ×3 bands; below-floor rows dimmed; footer band legend + "throughput/latency = last 30 min P50".
- States: no key → inline prompt + link; zero active providers → message; scrape failure → amber "privacy flags unverified" note, table intact.
- i18n en/zh via `locales.ts`.

## 4. Errors

- Malformed `modelId` → rejected client-side.
- Endpoints non-2xx/network/abort → `provider-value-failed`, retry button.
- No key → `provider-value-credential-missing`.
- Scrape failure non-fatal → `privacy: 'unknown'`, toggle disabled with note.
- AbortSignal propagated; secrets never in events/errors/responses.

## 5. Implementation steps

1. **Contract:** types + zod schemas + `LlmApi` JSDoc in `packages/host/apiproxy/src/api/{llm,llm.schema}.ts`; RPC-map wiring; fetch client + portal fixtures (`connection/src/client/fixture.ts`, `tests/fake-api.client.ts`).
2. **Host handler:** auth'd fetch to the endpoints API (path-build from `author/slug`, bearer key via credentials → env), row normalize + compute (prices ×1e6, bands, score, rank, uptime dim, status filter), error taxonomy.
3. **Privacy scrape:** model-page fetch, provider-name → `Privacy: Private` badge mapping, `unknown` fallback; toggle disabled when unknown.
4. **Widget:** `ModelsSection` (or sibling component) — input, sliders, table, states; `ModelProvider.module.css`; `locales.ts` en/zh.
5. **Tests:** api-proxy spec (fixture fetch: header, ranking math, status/uptime filtering, scrape mapping incl. malformed, credential-missing, network errors); client tests (render, winner badge, bands, toggle, error states); snapshot in `apps/web/tests/snapshots/models-settings/`; key-gated `test:e2e` (live endpoints ≥1 active row).
6. **Docs:** this plan → formal spec `docs/superpowers/specs/2026-08-18-openrouter-provider-value-design.md`; RPC JSDoc; Agent Note for the scrape decision.

## 6. Verification

`pnpm run test` (focused suites), `pnpm run test:coverage` (100% per touched file), `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, `git diff --check`.

## 7. Open questions

- `status` semantics for `-2`/`-5` — routable or not?
- 50% "typical" cache band is an assumption; could calibrate from OpenRouter's "average price actually paid".
- Whether `discount` is already reflected in the displayed price (verify before shipping the per-1M numbers).
- Better source than the HTML scrape if OpenRouter later publishes a provider privacy/training flag.