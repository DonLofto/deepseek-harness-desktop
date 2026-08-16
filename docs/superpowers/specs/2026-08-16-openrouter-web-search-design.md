# OpenRouter Web Search Provider Design

**Date:** 2026-08-16
**Status:** Approved
**Package:** `@deepseek-ai/dsh-web-search-openrouter` (`packages/web/web-search-openrouter`)

## 1. Goal

Make OpenRouter the shipped web-search provider while preserving the existing model-facing `web_search` tool and `ctx.web` service. Keep `@deepseek-ai/dsh-web-search-deepseek` in the workspace as an opt-in provider enabled by an explicit patch.

## 2. Architecture

The new `web-search-openrouter` package is a function/namespace plugin that registers one `WebSearchProvider` with `ctx.web`. It owns the OpenRouter HTTP request, credential resolution, response mapping, cancellation, provider errors, and secret-free request logging; it does not call `ctx.llm`.

The base bundle changes its `web` row to `searchProvider: openrouter` and mounts only `web-search-openrouter`. The DeepSeek provider remains available as a package but is not mounted in the default profile, preventing duplicate credential-backed providers and keeping the shipped settings page unambiguous.

OpenRouter's current server-tool interface is used through Chat Completions: the request includes `{ type: 'openrouter:web_search' }`, OpenRouter performs the search, and the response exposes normalized `url_citation` annotations. The provider uses the `auto` engine, which lets OpenRouter select native search or its hosted fallback. See the [OpenRouter web-search server-tool reference](https://openrouter.ai/docs/guides/features/server-tools/web-search).

## 3. Package Layout

```text
packages/web/web-search-openrouter/
├── package.json
├── tsconfig.json
├── README.md
├── README.zh.md
├── README.i18n.yaml
├── src/
│   ├── index.ts       # Cordis plugin entry, settings projection, and registration
│   ├── provider.ts    # OpenRouter request, response mapping, errors, and cancellation
│   ├── types.ts       # OpenRouter Chat Completions and annotation types
│   └── invariant.ts   # Package runtime invariant registration
└── tests/
    ├── openrouter.spec.ts
    └── openrouter.e2e.ts
```

The package follows the existing web-search provider package contract: namespace exports named `name`, `inject`, `Config`, and `apply`; `@deepseek-ai/dsh-web` remains the provider seam; `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-launch-environment`, `@deepseek-ai/dsh-session`, and `@deepseek-ai/dsh-settings` supply the existing credential, environment, session, and settings planes.

## 4. Provider Configuration

```ts
export interface Config {
  apiKey?: string
  apiKeyEnv?: string
  baseURL?: string
  model?: string
  maxUses?: number
}
```

The defaults are `apiKeyEnv: 'OPENROUTER_API_KEY'`, `baseURL: 'https://openrouter.ai/api/v1'`, `model: 'openrouter/auto'`, and `maxUses: 5`. `maxUses` must be a positive integer. The API key is a secret configuration field and is resolved through the credentials service for every search, with the launch environment as the fallback when the credentials service is absent.

The stable provider id is `openrouter`. The provider is usable only when its key source is configured, its base URL parses as an absolute URL, and `maxUses` is valid. `available()` performs no network request.

## 5. OpenRouter Request and Result Mapping

For one `WebSearchRequest`, the provider posts to `${baseURL}/chat/completions` with bearer authentication and `redirect: 'error'`.

```json
{
  "model": "openrouter/auto",
  "messages": [
    {
      "role": "user",
      "content": "Use web search to answer this query and cite the returned sources: <query>"
    }
  ],
  "tools": [
    {
      "type": "openrouter:web_search",
      "parameters": {
        "engine": "auto",
        "max_results": 8,
        "max_total_results": 8,
        "max_uses": 5
      }
    }
  ]
}
```

When `request.maxResults` is present, the provider sends it as both `max_results` and `max_total_results`; the `ctx.web` seam remains authoritative for the final cap. When it is absent, the provider omits those result-count fields and sends only the configured `maxUses`.

The response mapper reads the first assistant message. Its text becomes `WebSearchResult.content` when non-empty. Each `url_citation` annotation becomes one `WebSearchSource` with `url`, optional `title`, and optional `snippet` from the annotation's `content`; `publishedAt` is omitted because OpenRouter citations do not guarantee a publication date. Duplicate URLs are removed while preserving first-seen order.

A successful response without a `url_citation` annotation throws `WEB_PROVIDER_ERROR`, even when it contains prose. The web provider must not report an ungrounded answer as search evidence.

## 6. Credentials, Errors, Cancellation, and Logging

The provider resolves `OPENROUTER_API_KEY` per operation so credential-store writes and rotations take effect without a restart. A missing key throws `WEB_PROVIDER_CREDENTIAL_MISSING` and names the credential reference without exposing a value.

Non-2xx responses become `WEB_PROVIDER_ERROR` with the OpenRouter error detail when present, otherwise an HTTP-status message. Malformed success bodies, network failures, provider credential-resolution failures, and redirect responses use the same provider-error taxonomy as the existing web-search adapters. Caller cancellation and aborts during credential resolution, fetch, or body parsing become `WEB_ABORTED`.

Before the HTTP dispatch, the provider records a `web/openrouter-search-llm-request` session event containing the endpoint and secret-free request body. The API key never enters the event, settings response, or error message.

## 7. Bundle and Settings UI

The base bundle mounts:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: openrouter

- id: web-search-openrouter
  name: '@deepseek-ai/dsh-web-search-openrouter'
  config:
    apiKeyEnv: OPENROUTER_API_KEY
```

The DeepSeek provider is enabled by a user patch that inserts its plugin row and replaces the `web` row with `searchProvider: deepseek-official`. The patch is documented in the CLI and bundle-facing documentation.

The existing web-search settings card is retargeted to the `web-search-openrouter` namespace. It edits API endpoint, model, and maximum searches, and writes the API key only through the credentials RPC. Its English and Chinese copy names OpenRouter and explains that the key is stored outside the settings document. No DeepSeek settings card is mounted in the shipped client composition.

## 8. Documentation and Required Artifacts

The new package README documents configuration, credential references, request semantics, citation mapping, model-visible effects, failure codes, and the opt-in DeepSeek patch. Generated configuration, module, package, and CLI composition catalogs are regenerated from source through `pnpm run doc-sync`; generated English catalogs are not hand-edited.

An implemented Agent Note records why the default uses OpenRouter, why DeepSeek is opt-in, why the provider owns an auxiliary OpenRouter request instead of using `ctx.llm`, and which tests prove the selection and citation invariants.

## 9. Verification

`tests/openrouter.spec.ts` covers annotation mapping, duplicate removal, request-body and header mapping, request logging order, credential rotation and missing keys, provider availability, HTTP and malformed-response errors, redirects, aborts, and HMR-safe registration/disposal. It also drives the real Loader export-unwrapping path used by the existing provider tests.

`tests/openrouter.e2e.ts` uses a configured OpenRouter key when available and otherwise skips under the repository's real-API test policy. It verifies a live search returns at least one normalized citation without asserting provider-specific wording.

The settings client tests cover the new namespace, model field, credential state, save/reset behavior, and localized labels. Bundle and composition tests prove that OpenRouter is the selected default and DeepSeek is absent from the default mount list. The final checks are the focused Vitest suites, `pnpm run doc-sync`, `pnpm run typecheck`, `pnpm run build`, relevant hygiene checks, and `git diff --check`.

## 10. Alternatives Considered

### Reuse the DeepSeek provider with an OpenRouter base URL

Rejected because the DeepSeek implementation sends Anthropic Messages requests and expects native `web_search_tool_result` blocks, while OpenRouter requires Chat Completions with `openrouter:web_search` and returns `url_citation` annotations.

### Use OpenRouter's deprecated `plugins: [{ id: 'web' }]` or `:online` variant

Rejected because OpenRouter documents the `openrouter:web_search` server tool as the current path and gives the model control over search frequency and limits. The provider should not add a new dependency on a deprecated request mode.

### Route the auxiliary search through `ctx.llm`

Rejected because this search call has provider-specific wire fields and citation annotations, and coupling it to the active LLM adapter would hide the OpenRouter credential and response contract behind a model-capability service. The web provider remains an independent implementation of the existing seam.
