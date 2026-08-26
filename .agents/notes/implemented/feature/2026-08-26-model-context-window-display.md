# Agent Note: Model context window discovery, wire propagation, and UI display

Status: implemented

English | [中文](2026-08-26-model-context-window-display.zh.md)

## Problem

Models advertised by providers such as DeepSeek, OpenRouter, and custom gateways possess varying context window limits (e.g. 128K, 200K, 1M tokens) and maximum output token caps. Previously, while `@deepseek-ai/dsh-llm` adapters resolved `LlmResolvedModelInfo.context.contextWindow` and `defaultMaxTokens`, the API proxy (`packages/host/apiproxy`) dropped these capacities when constructing `ModelProviderGroup.models` entries for `session.models` and `llm.models`. Consequently, client surfaces (the composer model picker and `/model` popup) lacked visibility into context capacity, and users could not see or search models by their context size.

## Decision

We expose and display model context window capacities end-to-end across the wire schema, API proxy, and client selection surfaces:

- **API Proxy Wire Schema (`packages/host/apiproxy`)**:
  - Extended `ModelCatalogModel` and `modelCatalogModelSchema` in `sessions.ts` and `sessions.schema.ts` with optional `contextWindow` and `maxTokens` fields.
  - Updated `buildModelCatalog` in `api-proxy.ts` to extract `resolved.context?.contextWindow` and `resolved.defaultMaxTokens` from resolved model metadata and pass them to catalog entries.

- **Token Capacity Formatter (`packages/client/ui-model-selection/src/client/format.ts`)**:
  - Implemented `formatTokenCapacity(tokens)` formatting token numbers into standard, human-readable labels (`1048576` -> `1M`, `200000` -> `200K`, `131072` -> `128K`, `65536` -> `64K`, `32768` -> `32K`, `8192` -> `8K`, `4096` -> `4K`).

- **Composer Model Seat (`packages/client/ui-model-selection/src/client/ModelSelect.tsx`)**:
  - Rendered a `.contextBadge` tag next to the model name in each dropdown item when `model.contextWindow` is present, styled with `--dsw-*` tokens in `ModelSelect.module.css`.

- **Command Popup Filtering (`packages/client/ui-model-selection/src/client/index.ts`)**:
  - Included the formatted context capacity in `/model` popup option details (e.g. `DeepSeek · deepseek-v4-flash · 128K ctx`), enabling real-time fuzzy search by context size.

## Alternatives considered

**Omit context window from model catalog RPCs and query per model.** Increases client roundtrips and complicates list rendering; including optional capacities in `ModelCatalogModel` keeps catalog resolution atomic.

**Display raw token numbers without formatting.** Unformatted token numbers (e.g. `1048576`) are hard to parse at a glance; standard `K`/`M` formatting matches developer expectations.

## Consequences

- Users can immediately view each model's context capacity in the model selector.
- Users can filter models in `/model` by typing context sizes like `1M` or `128k`.
- The wire schema remains backward-compatible with optional numeric capacities.

## Testing

- Unit tests in `packages/host/apiproxy/tests/api-proxy-models.spec.ts` verify that `contextWindow` and `maxTokens` are extracted and serialized in `session.models` responses.
- Unit tests in `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` verify that context window badges render for models with `contextWindow`.
- Unit tests in `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` verify that `/model` option details include formatted context window labels.
