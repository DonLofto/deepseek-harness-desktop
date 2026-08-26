# Agent Note: OpenRouter live model discovery, metadata mapping, and selector search

Status: implemented

English | [中文](2026-08-26-openrouter-live-model-discovery.zh.md)

## Problem

OpenRouter frequently adds new LLM models, variants, and pricing tiers that exceed any static bundled catalog. Previously, `@deepseek-ai/dsh-llm-pi-ai` resolved OpenRouter exclusively through static catalog descriptors or explicitly hand-declared `models` arrays. When configured with an OpenRouter API key, users were limited to the static catalog snapshot bundled at build time unless they manually declared each model ID and capacity in `settings.yaml`.

Furthermore, the composer model seat (`ModelSelect.tsx`) and the `/model` popup select lacked real-time search filtering across loaded models, making navigation cumbersome when hundreds of models are available. The "Fetch available models" dialog in the Settings UI also lacked search filtering for large candidate lists.

## Decision

We introduce automatic live model discovery, caching, and capability mapping for OpenRouter across the adapter, host, and client UI layers:

- **Dynamic Catalog Fetcher (`packages/llm/llm-pi-ai/src/openrouter.ts`)**:
  - Automatically queries `GET https://openrouter.ai/api/v1/models` using the configured OpenRouter API key and standard DeepSeek Harness attribution headers (`HTTP-Referer`, `X-Title`, and `User-Agent`).
  - Maps OpenRouter model metadata into pi-ai `Model<Api>` descriptors:
    - `id` -> `Model.id`
    - `name` -> `Model.name`
    - `context_length` -> `contextWindow`
    - `top_provider.max_completion_tokens` / `max_output_tokens` / `max_tokens` -> `maxTokens`
    - `architecture.modality` and `input` -> `['text']` or `['text', 'image']`
    - `supported_parameters` (detecting `reasoning` or `include_reasoning`) -> enables `reasoning: true` with standard `ThinkingLevelMap`.
  - Caches discovered models in-memory with a configurable 1-hour TTL (`openrouterCatalogTtlMs`).
  - Falls back gracefully to the bundled static catalog on offline or network failure.
  - Overlays user-defined `presets` and `modelOverrides` over live models to preserve custom configurations.
  - Registers active models with the provider route so `getModels()` and model resolution dynamically recognize all live models.

- **Settings Discovery Hook (`packages/llm/llm-pi-ai/src/discovery.ts`)**:
  - `discoverModels()` queries the live OpenRouter endpoint rather than short-circuiting to static models when "Fetch available models" is triggered in the Settings UI.

- **Composer & Command Model Selector Search (`packages/client/ui-model-selection`)**:
  - `ModelSelect.tsx`: Adds a real-time search input at the top of `pane === 'model'`, auto-focused when opened, supporting keyboard navigation (`ArrowDown`, `Enter`, `Escape`), and filtering models by name, ID, and description with empty search state fallback.
  - `optionsOf` in `index.ts`: Includes `${group.name} · ${model.id}` in `detail` so fuzzy search in the `/model` popup indexed model IDs alongside names and descriptions.

- **Settings Candidate Search (`packages/client/ui-settings-models`)**:
  - `ModelListEditor.tsx`: Adds candidate filtering and select-all/deselect-all actions on filtered items in the "Fetch available models" adoption dialog.

## Alternatives considered

**Require manual entry for every unbundled model.** Preserves static immutability but burdens users with tracking upstream model releases and typing JSON configurations.

**Perform unbuffered background polling.** Periodic polling wastes bandwidth and adds lifecycle complexity; in-memory TTL caching during active session catalog requests achieves fresh listings with bounded network overhead.

## Consequences

- OpenRouter users immediately see new upstream models without waiting for harness releases.
- Navigation remains fast and keyboard-friendly even with hundreds of models available.
- Offline behavior remains fully functional via static catalog fallback.

## Testing

- Unit tests in `packages/llm/llm-pi-ai/tests/openrouter.spec.ts` verify model metadata mapping, reasoning extraction, live fetching, TTL caching, fallback, presets overlays, and discovery integration.
- Unit tests in `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` and `browser-plugin.client.spec.ts` verify real-time search filtering, keyboard navigation, and `/model` popup indexing.
- Unit tests in `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx` verify candidate search filtering and selection in the Settings modal.
