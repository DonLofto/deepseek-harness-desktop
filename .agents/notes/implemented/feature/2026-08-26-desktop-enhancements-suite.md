# Agent Note: Desktop enhancements suite (model pricing, pinned models, and markdown export)

Status: implemented

English | [中文](2026-08-26-desktop-enhancements-suite.zh.md)

## Problem

As DeepSeek Harness Desktop handles diverse models and extended workflows, users needed visibility into model token pricing, quick access to frequently used models, and the ability to export full session histories for sharing or archiving:

1. **Model Token Pricing Visibility**: Live OpenRouter catalog metadata provides per-token prompt and completion pricing, but the harness dropped pricing information during catalog resolution. Users could not easily identify free models versus premium frontier models.
2. **Pinned / Favorite Models**: When providers expose dozens or hundreds of models, scrolling or searching on every switch creates friction.
3. **Session Markdown Export**: Users needed an accessible method to export complete conversation transcripts (including user prompts, thinking blocks, and assistant responses) into clean GitHub-flavored Markdown.

## Decision

We implemented the Desktop Enhancements Suite across the LLM adapters, API proxy, and client UI packages:

- **Model Pricing & Cost Badges**:
  - `packages/llm/llm-pi-ai/src/openrouter.ts`: Parsed `pricing: { prompt, completion }` from live OpenRouter metadata and converted per-token USD into `ModelCost` (cost per million tokens).
  - `packages/llm/llm/src/types.ts` & `src/index.ts`: Propagated `cost?: { input?: number; output?: number }` across `LlmResolvedModelInfo`.
  - `packages/host/apiproxy/src/api/sessions.ts` & `sessions.schema.ts`: Added optional `pricing` schema to `ModelCatalogModel` and wired `resolved.cost` in `api-proxy.ts`.
  - `packages/client/ui-model-selection/src/client/format.ts`: Implemented `formatModelPricing(pricing)` (`Free`, `<$0.01/1M`, `$0.15/1M`, `$3/1M`).
  - `packages/client/ui-model-selection/src/client/ModelSelect.tsx`: Rendered `.pricingBadge` beside `.contextBadge` and indexed pricing in `/model` popup search details.

- **Pinned / Favorite Models Quick-Switcher**:
  - `packages/client/ui-model-selection/src/client/pins.ts`: Backed pinned model keys in `localStorage` under `dsh.pinnedModels`.
  - `packages/client/ui-model-selection/src/client/ModelSelect.tsx`: Rendered star action buttons on each model option and dynamically prepended a `⭐ Pinned` group to the top of the selector list.

- **One-Click Session Export to Markdown**:
  - `packages/client/ui-conversation/src/client/export/markdown.ts`: Formatted `ConversationSnapshot` nodes into clean, structured Markdown with session metadata, user blocks, thinking quotes (`> **Thinking:**`), and assistant responses, along with browser `downloadMarkdown` utility.

## Alternatives considered

**Query per-token pricing on every request instead of propagating via model catalog.** Adds redundant RPC roundtrips and degrades picker responsiveness; incorporating optional pricing into the model catalog keeps metadata atomic and cached.

**In-memory model pin state without localStorage persistence.** Pins would reset on every window reload or new tab, losing user customization.

**Exporting raw JSON logs instead of formatted Markdown.** JSON is suitable for programmatic replay but unusable for user sharing and document authoring; GitHub-flavored Markdown provides an immediate, portable reading experience.

## Consequences

- Users gain immediate visibility into pricing tiers (`Free` vs `$X/1M`) directly inside the model picker and `/model` popup.
- Frequently used models can be starred and kept at the top of the picker for one-click selection.
- Complete conversation histories can be exported to standard GitHub-flavored Markdown.

## Testing

- Unit tests in `packages/llm/llm-pi-ai/tests/openrouter.spec.ts` verify pricing parsing and cost calculation.
- Tests in `packages/host/apiproxy/tests/api-proxy-models.spec.ts` verify pricing wire serialization.
- Tests in `packages/client/ui-model-selection/tests/model-select.client.spec.tsx` verify pricing badge rendering and model pinning interactions.
- Tests in `packages/client/ui-conversation/tests/export-markdown.client.spec.ts` verify Markdown session generation.
- Full typecheck and 1,112 vitest tests pass across all packages with zero errors.
