# @deepseek-ai/dsh-llm-gemini

English | [中文](README.zh.md)

Google Gemini subscription and Cloud Code PA LLM provider for the DeepSeek Harness LLM seam.

This plugin enables authentication through Google OAuth 2.0 Device Code flow, queries Google Cloud Code PA (`https://daily-cloudcode-pa.googleapis.com`) for subscription tiers, companion projects, and quota summaries, and streams model inference turns via the Gemini API (`https://generativelanguage.googleapis.com`) with entitlement-aware HTTP 402/426 quota handling.

The package exposes the Cordis plugin entrypoint, Google OAuth token management, the Cloud Code PA client, and the Gemini streaming adapter.

## Config

```yaml
- id: llm-gemini
  name: '@deepseek-ai/dsh-llm-gemini'
  config:
    cloudCodeEndpoint: https://daily-cloudcode-pa.googleapis.com # optional Cloud Code PA base URL
    apiServerUrl: https://generativelanguage.googleapis.com      # optional Gemini API server URL
    subclientType: hub                                           # optional client type identifier
    ideName: antigravity                                         # optional IDE client name
```

The plugin registers the provider route `google-gemini` on `ctx.llm`.

## Model Experience

### Gemini request

#### What the model sees

The selected Gemini model receives the harness system prompt, message history, tool schemas, and generation config translated into Gemini Content and GenerateContentRequest payloads without adapter-authored prompt prose.

#### Token effect

Provider tokenization governs exact input. Generated tokens follow the request's maxTokens setting and model context boundaries.

#### KV Cache effect

Consecutive turns within a session are eligible for provider context caching where supported by Gemini endpoints.

### Gemini response

#### What the model sees

Text candidates, reasoning thought blocks, and function call invocations are translated into harness `StreamChunk` events for the loop to log and assemble.

#### Token effect

Usage metadata is captured in `usage` chunks, and quota consumption is reconciled against subscription tier limits.

#### KV Cache effect

Response tokens populate downstream conversation context for subsequent turns.

## Known Limitations and Deferred Work

- Interactive Device Code OAuth login requires desktop browser interaction.
