# Google Gemini Subscription Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and integrate the native `@deepseek-ai/dsh-llm-gemini` Cordis plugin to enable Google Gemini subscription-based authentication (Device Code flow), Cloud Code PA entitlement and quota synchronization, and stream inference turns with quota error handling.

**Architecture:** A dedicated Cordis provider plugin under `packages/llm/llm-gemini/` that implements the Antigravity Hub contract: authenticates with Google OAuth 2.0 Device Code flow, queries Cloud Code PA (`https://daily-cloudcode-pa.googleapis.com`) for user tiers and companion projects, persists tokens in `$DSH_HOME/.credentials.oauth.json`, and streams inference via Gemini API with HTTP 402/426 quota handling.

**Tech Stack:** TypeScript (ESM, strict), Cordis, Schemastery, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-credentials-local`, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-16-google-gemini-subscription-provider-design.md`](file:///Users/patrick/GitHubForks/DSHDesktop/deepseek-harness-desktop/docs/superpowers/specs/2026-08-16-google-gemini-subscription-provider-design.md)

## Global Constraints

- ESM everywhere (`"type": "module"`), strict TypeScript, no unannotated `any`.
- Plugin registrations must be managed effects (`ctx.effect()`).
- Credentials must be stored securely with owner-only `0600` POSIX permissions via `OAuthFileCredentialStore`.
- All network calls must accept an `AbortSignal`.
- 100% test coverage for newly introduced packages.

---

### Task 1: Package Scaffolding, Proto Models, and Configuration Schema

**Files:**
- Create: `packages/llm/llm-gemini/package.json`
- Create: `packages/llm/llm-gemini/tsconfig.json`
- Create: `packages/llm/llm-gemini/README.md`
- Create: `packages/llm/llm-gemini/src/types.ts`
- Create: `packages/llm/llm-gemini/src/config.ts`
- Test: `packages/llm/llm-gemini/tests/config.spec.ts`

**Interfaces:**
- Produces: `UserTier`, `OnboardUserResponse`, `QuotaSummary`, `GeminiConfig`, `resolveGeminiConfig`

- [ ] **Step 1: Write `package.json` and `tsconfig.json`**

```json
{
  "name": "@deepseek-ai/dsh-llm-gemini",
  "description": "Google Gemini subscription and Cloud Code PA LLM provider for DeepSeek Harness",
  "version": "0.1.0-rc.10",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-credentials-local": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^"
  }
}
```

- [ ] **Step 2: Write failing test for config schema in `tests/config.spec.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { Config, resolveGeminiConfig } from '../src/config.ts'

describe('Gemini Config Schema', () => {
  it('supplies canonical defaults when empty', () => {
    const resolved = resolveGeminiConfig({})
    expect(resolved.cloudCodeEndpoint).toBe('https://daily-cloudcode-pa.googleapis.com')
    expect(resolved.apiServerUrl).toBe('https://generativelanguage.googleapis.com')
    expect(resolved.subclientType).toBe('hub')
  })
})
```

- [ ] **Step 3: Implement `src/types.ts` and `src/config.ts`**

```typescript
// packages/llm/llm-gemini/src/types.ts
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @deepseek-ai/dsh-llm-gemini run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/llm/llm-gemini
git commit -m "feat(llm-gemini): scaffold package, types, and configuration schema"
```

---

### Task 2: Google OAuth 2.0 Device Flow & Token Management

**Files:**
- Create: `packages/llm/llm-gemini/src/oauth.ts`
- Create: `packages/llm/llm-gemini/tests/oauth.spec.ts`

**Interfaces:**
- Produces: `initiateGoogleDeviceFlow`, `pollGoogleDeviceToken`, `refreshGoogleToken`

- [ ] **Step 1: Write failing test in `tests/oauth.spec.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initiateGoogleDeviceFlow, pollGoogleDeviceToken } from '../src/oauth.ts'

describe('Google OAuth Device Flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('initiates device code flow with expected scopes and endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        device_code: 'dev_123',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://www.google.com/device',
        expires_in: 1800,
        interval: 5,
      }),
    })
    globalThis.fetch = mockFetch as any

    const res = await initiateGoogleDeviceFlow({ clientId: 'test-client' })
    expect(res.device_code).toBe('dev_123')
    expect(res.user_code).toBe('ABCD-EFGH')
  })
})
```

- [ ] **Step 2: Implement `src/oauth.ts`**

Implement device code request, interval polling loop, exponential backoff on `slow_down`, abort signal handling, and token refresh.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm --filter @deepseek-ai/dsh-llm-gemini run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/llm/llm-gemini/src/oauth.ts packages/llm/llm-gemini/tests/oauth.spec.ts
git commit -m "feat(llm-gemini): implement Google OAuth 2.0 device code flow and token refresh"
```

---

### Task 3: Cloud Code PA Entitlement & Quota Client

**Files:**
- Create: `packages/llm/llm-gemini/src/cloud-code-client.ts`
- Create: `packages/llm/llm-gemini/tests/cloud-code-client.spec.ts`

**Interfaces:**
- Produces: `CloudCodeClient` class (`onboardUser`, `retrieveUserQuotaSummary`, `listModelConfigs`)

- [ ] **Step 1: Write failing test in `tests/cloud-code-client.spec.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { CloudCodeClient } from '../src/cloud-code-client.ts'

describe('CloudCodeClient', () => {
  it('calls OnboardUser with correct hub subclient headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        userTier: { id: 'AGY_BUSINESS_PAYGO_TIER', name: 'Gemini Business' },
        cloudaicompanionProject: 'projects/123456789',
      }),
    })
    globalThis.fetch = mockFetch as any

    const client = new CloudCodeClient('https://daily-cloudcode-pa.googleapis.com')
    const res = await client.onboardUser('mock-token')

    expect(res.userTier?.id).toBe('AGY_BUSINESS_PAYGO_TIER')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-goog-api-client': 'antigravity/hub',
          'User-Agent': 'antigravity',
        }),
      }),
    )
  })
})
```

- [ ] **Step 2: Implement `src/cloud-code-client.ts`**

Implement `CloudCodeClient` with methods for `onboardUser`, `retrieveUserQuotaSummary`, and `listModelConfigs`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm --filter @deepseek-ai/dsh-llm-gemini run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/llm/llm-gemini/src/cloud-code-client.ts packages/llm/llm-gemini/tests/cloud-code-client.spec.ts
git commit -m "feat(llm-gemini): implement Cloud Code PA client for entitlements and quota"
```

---

### Task 4: Gemini SSE Stream Parser & Error Translation

**Files:**
- Create: `packages/llm/llm-gemini/src/stream.ts`
- Create: `packages/llm/llm-gemini/src/error.ts`
- Create: `packages/llm/llm-gemini/tests/stream.spec.ts`

**Interfaces:**
- Produces: `parseGeminiStreamChunk`, `translateGeminiError`, `streamGeminiResponse`

- [ ] **Step 1: Write failing test in `tests/stream.spec.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { parseGeminiStreamChunk } from '../src/stream.ts'

describe('Gemini Stream Chunk Parser', () => {
  it('extracts text candidates and thought blocks', () => {
    const chunk = JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: 'Hello from Gemini!' },
            { thought: 'Thinking through plan...' },
          ],
        },
      }],
    })
    const parsed = parseGeminiStreamChunk(chunk)
    expect(parsed.text).toBe('Hello from Gemini!')
    expect(parsed.thought).toBe('Thinking through plan...')
  })
})
```

- [ ] **Step 2: Implement `src/stream.ts` and `src/error.ts`**

Implement line-by-line SSE parsing, tool call translation, and HTTP 402/426 quota error translation using `LlmError`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm --filter @deepseek-ai/dsh-llm-gemini run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/llm/llm-gemini/src/stream.ts packages/llm/llm-gemini/src/error.ts packages/llm/llm-gemini/tests/stream.spec.ts
git commit -m "feat(llm-gemini): implement SSE streaming parser and quota error translation"
```

---

### Task 5: Gemini LLM Adapter & Model Catalog

**Files:**
- Create: `packages/llm/llm-gemini/src/adapter.ts`
- Create: `packages/llm/llm-gemini/tests/adapter.spec.ts`

**Interfaces:**
- Produces: `GeminiAdapter` (implements `LlmAdapter`)

- [ ] **Step 1: Write failing test in `tests/adapter.spec.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { GeminiAdapter } from '../src/adapter.ts'

describe('GeminiAdapter', () => {
  it('provides default tier models in model catalog', () => {
    const adapter = new GeminiAdapter({
      getCredentials: async () => ({ token: 'test-token', projectId: 'test-proj' }),
    })
    const catalog = adapter.modelCatalog()
    expect(catalog.map(m => m.id)).toContain('gemini-2.5-pro')
    expect(catalog.map(m => m.id)).toContain('gemini-2.5-flash')
  })
})
```

- [ ] **Step 2: Implement `src/adapter.ts`**

Implement `GeminiAdapter` integrating `CloudCodeClient`, `OAuthFileCredentialStore`, and `streamGeminiResponse`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm --filter @deepseek-ai/dsh-llm-gemini run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/llm/llm-gemini/src/adapter.ts packages/llm/llm-gemini/tests/adapter.spec.ts
git commit -m "feat(llm-gemini): implement Gemini LlmAdapter with tier-aware catalog"
```

---

### Task 6: Cordis Plugin Entrypoint, Lifecycle, and Seam Registration

**Files:**
- Create: `packages/llm/llm-gemini/src/index.ts`
- Create: `packages/llm/llm-gemini/tests/index.spec.ts`

**Interfaces:**
- Produces: `name`, `inject`, `apply(ctx, config)`

- [ ] **Step 1: Write failing test in `tests/index.spec.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as LlmService from '@deepseek-ai/dsh-llm'
import * as GeminiPlugin from '../src/index.ts'

describe('Gemini Cordis Plugin', () => {
  it('registers OAuth login handler and configurable provider directory', () => {
    const ctx = new Context()
    ctx.plugin(LlmService)
    ctx.plugin(GeminiPlugin, {})

    expect(ctx.llm.configurableProviders().map(p => p.provider)).toContain('google-gemini')
  })
})
```

- [ ] **Step 2: Implement `src/index.ts`**

Wire `ctx.llm.registerOAuthLogin`, `ctx.llm.registerConfigurableProviders`, `ctx.llm.registerModelDiscovery`, and `ctx.llm.registerAdapter`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm --filter @deepseek-ai/dsh-llm-gemini run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/llm/llm-gemini/src/index.ts packages/llm/llm-gemini/tests/index.spec.ts
git commit -m "feat(llm-gemini): implement Cordis plugin entrypoint and seam registrations"
```

---

### Task 7: Workspace Integration & End-to-End Verification

**Files:**
- Modify: `pnpm-workspace.yaml` (ensure `packages/llm/llm-gemini` included)
- Modify: `packages/bundle/base/package.json` & `cordis.yml` (mount `@deepseek-ai/dsh-llm-gemini`)
- Modify: `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` (add `google-gemini` OAuth button label/branding)

- [ ] **Step 1: Update workspace and bundle definitions**
- [ ] **Step 2: Run repository test suite and typechecks**

Run:
```bash
pnpm run typecheck
pnpm run lint
pnpm --filter @deepseek-ai/dsh-llm-gemini run test
```
Expected: All gates PASS with 0 errors.

- [ ] **Step 3: Commit**

```bash
git add pnpm-workspace.yaml packages/bundle/base packages/client/ui-settings-models
git commit -m "feat(llm-gemini): integrate Google Gemini subscription provider into desktop harness"
```
