# Google Gemini Subscription Provider (`@deepseek-ai/dsh-llm-gemini`) Design

**Date:** 2026-08-16
**Status:** Approved
**Package:** `@deepseek-ai/dsh-llm-gemini` (`packages/llm/llm-gemini`)

---

## 1. Overview & Goals

Google Antigravity gates model access (e.g. `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3.1-pro-preview`) and manages user subscriptions via Google's internal **Cloud Code PA** service (`https://daily-cloudcode-pa.googleapis.com`) and the Gemini API (`https://generativelanguage.googleapis.com`).

This specification defines the native Cordis provider plugin `@deepseek-ai/dsh-llm-gemini` for DeepSeek Harness. It allows users with Google Gemini subscriptions (Gemini Advanced, Google One AI Premium, Gemini Business, or Enterprise Agent Tier) to authenticate via Google OAuth 2.0 Device Flow, synchronize their `UserTier` and companion project, and stream inference turns with entitlement-aware quota handling.

---

## 2. Architecture & Topology

```
┌────────────────────────────────────────────────────────┐
│  Web UI / Desktop Settings (ProviderEditor)            │
│  - "Sign in with Google" button                        │
│  - Model selection (tier-unlocked Gemini models)       │
└───────────────────────────┬────────────────────────────┘
                            │ RPC (`llm.startOAuthLogin`)
                            ▼
┌────────────────────────────────────────────────────────┐
│  DeepSeek Harness Runtime (Cordis)                     │
│  ├── dsh-credentials-local (OAuthFileCredentialStore)  │
│  └── @deepseek-ai/dsh-llm-gemini (Plugin)              │
└──────────────┬─────────────────────────┬───────────────┘
               │ 1. OAuth Device Flow    │ 2. Entitlement & Quota
               ▼                         ▼
┌──────────────────────────┐  ┌───────────────────────────────────────────┐
│ oauth2.googleapis.com    │  │ daily-cloudcode-pa.googleapis.com         │
│ - /device/code           │  │ - CloudCode/OnboardUser                   │
│ - /token                 │  │ - CloudCode/RetrieveUserQuotaSummary      │
└──────────────────────────┘  │ - CloudCode/ListModelConfigs              │
                              └─────────────────────┬─────────────────────┘
                                                    │ 3. Model Streaming
                                                    ▼
                              ┌───────────────────────────────────────────┐
                              │ generativelanguage.googleapis.com         │
                              │ - /v1beta/models/{model}:streamGenerateContent
                              │   Headers:                                │
                              │   - Authorization: Bearer <token>         │
                              │   - x-goog-user-project: <project>        │
                              │   - x-goog-api-client: antigravity/hub    │
                              │   - User-Agent: antigravity               │
                              └───────────────────────────────────────────┘
```

---

## 3. Package File Layout

```
packages/llm/llm-gemini/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts              # Cordis plugin entry point (apply, settings, lifecycle)
│   ├── config.ts             # Schemastery schema for plugin configuration
│   ├── types.ts              # Proto models: UserTier, Entitlement, QuotaSummary, ModelConfig
│   ├── oauth.ts              # Google Device Code flow & token refresh routines
│   ├── cloud-code-client.ts  # Cloud Code PA RPC client (OnboardUser, RetrieveUserQuotaSummary, ListModelConfigs)
│   ├── adapter.ts            # LlmAdapter implementation (modelCatalog, stream)
│   ├── stream.ts             # SSE stream consumer & Gemini JSON chunk translator
│   └── error.ts              # Error mapping for HTTP 402/426 and quota exhaustions
└── tests/
    ├── oauth.spec.ts
    ├── cloud-code-client.spec.ts
    ├── stream.spec.ts
    └── adapter.spec.ts
```

---

## 4. Component Specifications

### 4.1. Authentication (`src/oauth.ts`)
- **Protocol:** OAuth 2.0 Device Authorization Grant (`RFC 8628`).
- **Endpoints:**
  - Authorization: `https://oauth2.googleapis.com/device/code`
  - Token: `https://oauth2.googleapis.com/token`
- **Default Scopes:**
  - `https://www.googleapis.com/auth/cloud-platform`
  - `https://www.googleapis.com/auth/generative-language`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `openid`
- **Credential Storage:** Persisted in `$DSH_HOME/.credentials.oauth.json` via `OAuthFileCredentialStore` with POSIX `0600` owner-only permissions.
- **Refresh Strategy:** Checks `expiresAt` prior to requests; refreshes token transparently if remaining validity is under 5 minutes.

### 4.2. Cloud Code PA Client (`src/cloud-code-client.ts`)
- **Base URL:** `https://daily-cloudcode-pa.googleapis.com` (configurable via `cloudCodeEndpoint`).
- **Headers:**
  - `Authorization: Bearer <accessToken>`
  - `x-goog-api-client: antigravity/hub`
  - `User-Agent: antigravity`
  - `x-goog-user-project: <cloudaicompanionProject>` (when available)
- **Methods:**
  - `onboardUser(token: string)`: Calls `/v1internal:onboardUser` with `{ subclientType: 'hub', ideName: 'antigravity' }` to obtain `userTier`, `project`, and `cloudaicompanionProject`.
  - `retrieveUserQuotaSummary(token: string, project: string)`: Calls `/v1internal:retrieveUserQuotaSummary`.
  - `listModelConfigs(token: string, project: string)`: Calls `/v1internal:listModelConfigs` to resolve entitlement-authorized models for the user's tier.

### 4.3. Data Models (`src/types.ts`)
```typescript
export interface UserTier {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  userDefinedCloudaicompanionProject?: string
  upgradeSubscriptionUri?: string
  upgradeSubscriptionText?: string
  upgradeSubscriptionButtonText?: string
  upgradeSubscriptionType?: string
  availableCredits?: number
  clientExperienceTag?: string
}

export interface OnboardUserResponse {
  userTier?: UserTier
  project?: string
  location?: string
  cloudaicompanionProject?: string
}

export interface QuotaSummary {
  userTier: string
  remainingCredits?: number
  capacityExhausted?: boolean
}
```

### 4.4. Streaming Adapter & Error Translation (`src/adapter.ts`, `src/stream.ts`, `src/error.ts`)
- **Inference Route:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
- **Request Headers:**
  - `Authorization: Bearer <accessToken>`
  - `Content-Type: application/json`
  - `User-Agent: antigravity`
  - `x-goog-api-client: antigravity/hub`
  - `x-goog-user-project: <cloudaicompanionProject>`
- **Chunk Translation:** Maps Gemini `candidates[0].content.parts` to DSH `assistant/chunk` events (text tokens, reasoning thought blocks, tool call invocations).
- **Gating & Quota Interception:** Catches HTTP `402 Payment Required` and `426 Upgrade Required`. Uses `userTier.upgradeSubscriptionUri` (or fallback `https://one.google.com/explore-plan`) to throw an `LlmError` with code `QUOTA_EXHAUSTED` and actionable upgrade URL.

---

## 5. Plugin Entrypoint (`src/index.ts`)

- **Name:** `llm-gemini`
- **Injections:** `['llm', 'credentials']`
- **Effects & Registrations:**
  1. `ctx.llm.registerOAuthLogin('google-gemini', ...)`: Exposes device code initiation and token polling to the API proxy / UI.
  2. `ctx.llm.registerConfigurableProviders(...)`: Adds `google-gemini` to the configurable provider directory.
  3. `ctx.llm.registerModelDiscovery(...)`: Connects model discovery to `cloudCodeClient.listModelConfigs()`.
  4. `ctx.llm.registerAdapter(['google-gemini'], adapter)`: Registers the streaming LLM adapter instance.

---

## 6. Testing & Quality Gates

- **`tests/oauth.spec.ts`**: Mock Google OAuth endpoints; verify device code generation, polling intervals, token refresh on expiration, and AbortSignal handling.
- **`tests/cloud-code-client.spec.ts`**: Mock Cloud Code PA endpoints; verify `onboardUser`, `retrieveUserQuotaSummary`, and `listModelConfigs` RPC payloads and headers.
- **`tests/stream.spec.ts`**: Verify SSE chunk parser against Gemini response payloads containing standard text, thoughts, and tool calls.
- **`tests/adapter.spec.ts`**: Test the full `LlmAdapter` contract, model catalog resolution, and HTTP 402/426 quota error translation.
