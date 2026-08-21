import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SettingsProvider, { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as GeminiPlugin from '../src/index.ts'
import { DEFAULT_GEMINI_MODELS, DEFAULT_UPGRADE_URI } from '../src/index.ts'

interface OAuthCreds {
  type: string
  token: string
  refreshToken?: string
  expiresAt?: number
  projectId?: string
  userTier?: { id?: string; name?: string }
  upgradeUri?: string
}

class MockOAuthStore {
  private store = new Map<string, Record<string, unknown>>()

  async read(id: string): Promise<Record<string, unknown> | undefined> {
    return this.store.get(id)
  }

  async modify(
    id: string,
    fn: (curr: Record<string, unknown> | undefined) =>
      | Promise<Record<string, unknown> | undefined>
      | Record<string, unknown>
      | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const curr = this.store.get(id)
    const next = await fn(curr)
    if (next === undefined) {
      this.store.delete(id)
    } else {
      this.store.set(id, next)
    }
    return next
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }

  async list(): Promise<Array<{ providerId: string; type: string }>> {
    return [...this.store.entries()].map(([k, v]) => ({
      providerId: k,
      type: (v?.type as string) ?? 'oauth',
    }))
  }
}

class MockCredentialsService extends Service {
  oauthStore: MockOAuthStore

  constructor(ctx: Context) {
    super(ctx, 'credentials')
    this.oauthStore = new MockOAuthStore()
  }

  async resolve(_ref: unknown): Promise<string | undefined> {
    return undefined
  }

  async describe(_ref: unknown): Promise<{ configured: boolean; writable: boolean }> {
    return { configured: false, writable: false }
  }

  async set(_ref: unknown, _val: unknown): Promise<void> {}

  async unset(_ref: unknown): Promise<void> {}
}

class MockSettingsProvider extends SettingsProvider {
  override readonly writable = true
  private data: Record<string, unknown> = {}

  protected override async load(): Promise<Record<string, unknown>> {
    return this.data
  }

  protected override async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.data[ns] = section
  }
}

describe('Gemini Cordis Plugin (llm-gemini)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('exports expected plugin metadata and re-exports symbols', () => {
    expect(GeminiPlugin.name).toBe('llm-gemini')
    expect(GeminiPlugin.inject).toEqual(['llm'])
    expect(GeminiPlugin.PROVIDER).toBe('google-gemini')
    expect(typeof GeminiPlugin.apply).toBe('function')
    expect(typeof GeminiPlugin.Config).toBe('function')
    expect(typeof GeminiPlugin.resolveGeminiConfig).toBe('function')
    expect(typeof GeminiPlugin.initiateGoogleDeviceFlow).toBe('function')
    expect(typeof GeminiPlugin.pollGoogleDeviceToken).toBe('function')
    expect(typeof GeminiPlugin.refreshGoogleToken).toBe('function')
    expect(typeof GeminiPlugin.isTokenExpiringSoon).toBe('function')
    expect(typeof GeminiPlugin.sleep).toBe('function')
    expect(typeof GeminiPlugin.parseGeminiStreamChunk).toBe('function')
    expect(typeof GeminiPlugin.streamGeminiResponse).toBe('function')
    expect(typeof GeminiPlugin.mapGeminiFinishReason).toBe('function')
    expect(typeof GeminiPlugin.mapGeminiUsage).toBe('function')
    expect(typeof GeminiPlugin.translateGeminiError).toBe('function')
    expect(GeminiPlugin.DEFAULT_UPGRADE_URI).toBe('https://one.google.com/explore-plan')
    expect(typeof GeminiPlugin.GeminiAdapter).toBe('function')
    expect(typeof GeminiPlugin.buildGeminiRequestPayload).toBe('function')
    expect(typeof GeminiPlugin.CloudCodeClient).toBe('function')
    expect(Array.isArray(GeminiPlugin.DEFAULT_GEMINI_MODELS)).toBe(true)
  })

  it('registers configurable providers directory entry', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(GeminiPlugin, {})

    const configurable = ctx.llm.listConfigurableProviders()
    const entry = configurable.find(p => p.provider === 'google-gemini')
    expect(entry).toBeDefined()
    expect(entry).toEqual({
      provider: 'google-gemini',
      displayName: 'Google Gemini (Subscription / AI Pro)',
      oauth: true,
      settingsNs: 'llm-gemini',
      settingsPath: [],
      declared: false,
    })
  })

  it('registers Gemini adapter route and exposes provider & model metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(GeminiPlugin, {})

    const providers = ctx.llm.listProviders()
    const providerInfo = providers.find(p => p.id === 'google-gemini')
    expect(providerInfo).toEqual({
      id: 'google-gemini',
      name: 'Google Gemini',
    })

    const models = await ctx.llm.listModels('google-gemini')
    expect(models.length).toBeGreaterThan(0)
    expect(models.map(m => m.id)).toContain('gemini-2.5-pro')

    const resolved = await ctx.llm.resolveModelInfo('google-gemini', 'gemini-2.5-pro')
    expect(resolved.id).toBe('gemini-2.5-pro')
    expect(resolved.provider).toBe('google-gemini')
    expect(resolved.context?.contextWindow).toBe(1_048_576)

    const fallbackModel = await ctx.llm.resolveModelInfo('google-gemini', 'custom-future-gemini')
    expect(fallbackModel.id).toBe('custom-future-gemini')
    expect(fallbackModel.context?.contextWindow).toBe(1_048_576)
  })

  describe('OAuth Login Handler', () => {
    it('successfully initiates device flow, polls tokens, onboards user, and saves credentials to oauthStore', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MockCredentialsService)
      await ctx.plugin(GeminiPlugin, {})

      const mockFetch = vi.fn().mockImplementation(async (url: string | URL, _init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.includes('/device/code')) {
          return new Response(
            JSON.stringify({
              device_code: 'test_dev_code_123',
              user_code: 'GEM-7890',
              verification_url: 'https://google.com/device',
              expires_in: 1800,
              interval: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'test_access_token_abc',
              refresh_token: 'test_refresh_token_xyz',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/v1internal:onboardUser')) {
          return new Response(
            JSON.stringify({
              userTier: {
                id: 'TIER_PRO',
                name: 'Gemini Pro Subscription',
                upgradeSubscriptionUri: 'https://custom.upgrade.google.com',
              },
              project: 'test-gcp-project-456',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('Not Found', { status: 404 })
      })
      globalThis.fetch = mockFetch

      const onAuthUrl = vi.fn()
      const creds = await ctx.llm.startOAuthLogin('google-gemini', { onAuthUrl })

      expect(onAuthUrl).toHaveBeenCalledWith('https://google.com/device')
      expect(creds).toEqual({
        type: 'oauth',
        token: 'test_access_token_abc',
        refreshToken: 'test_refresh_token_xyz',
        expiresAt: expect.any(Number),
        projectId: 'test-gcp-project-456',
        userTier: {
          id: 'TIER_PRO',
          name: 'Gemini Pro Subscription',
          upgradeSubscriptionUri: 'https://custom.upgrade.google.com',
        },
        upgradeUri: 'https://custom.upgrade.google.com',
      })

      // Verify saved in oauthStore
      const stored = await ctx.get('credentials')?.oauthStore?.read('google-gemini')
      expect(stored).toEqual(creds)
    })

    it('handles verification_uri alias and cloudaicompanionProject extraction', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MockCredentialsService)
      await ctx.plugin(GeminiPlugin, {})

      const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()
        if (urlStr.includes('/device/code')) {
          return new Response(
            JSON.stringify({
              device_code: 'test_dev_code_alias',
              user_code: 'CODE-999',
              verification_uri: 'https://google.com/device/uri',
              expires_in: 1800,
              interval: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'test_token_alias',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/v1internal:onboardUser')) {
          return new Response(
            JSON.stringify({
              userTier: {
                id: 'TIER_STANDARD',
                name: 'Gemini Standard',
              },
              cloudaicompanionProject: 'projects/companion-proj-777',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('Not Found', { status: 404 })
      })
      globalThis.fetch = mockFetch

      const creds = (await ctx.llm.startOAuthLogin('google-gemini')) as OAuthCreds
      expect(creds.projectId).toBe('companion-proj-777')
      expect(creds.upgradeUri).toBe(DEFAULT_UPGRADE_URI)
    })

    it('handles empty verification_url and verification_uri fallback', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MockCredentialsService)
      await ctx.plugin(GeminiPlugin, {})

      const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()
        if (urlStr.includes('/device/code')) {
          return new Response(
            JSON.stringify({
              device_code: 'test_dev_code_empty_url',
              user_code: 'EMPTY-URL',
              verification_url: '',
              verification_uri: '',
              expires_in: 1800,
              interval: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'test_token_empty_url',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/v1internal:onboardUser')) {
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('Not Found', { status: 404 })
      })
      globalThis.fetch = mockFetch

      const onAuthUrl = vi.fn()
      const creds = (await ctx.llm.startOAuthLogin('google-gemini', { onAuthUrl })) as OAuthCreds
      expect(onAuthUrl).toHaveBeenCalledWith('')
      expect(creds.token).toBe('test_token_empty_url')
    })

    it('falls back gracefully when onboardUser fails or yields no project', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MockCredentialsService)
      await ctx.plugin(GeminiPlugin, {})

      const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()
        if (urlStr.includes('/device/code')) {
          return new Response(
            JSON.stringify({
              device_code: 'test_dev_code_err',
              user_code: 'ERR-000',
              verification_url: 'https://google.com/device',
              expires_in: 1800,
              interval: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'token_onboard_err',
              expires_in: 1800,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/v1internal:onboardUser')) {
          return new Response('Internal Server Error', { status: 500 })
        }
        return new Response('Not Found', { status: 404 })
      })
      globalThis.fetch = mockFetch

      const creds = (await ctx.llm.startOAuthLogin('google-gemini')) as OAuthCreds
      expect(creds.token).toBe('token_onboard_err')
      expect(creds.projectId).toBeUndefined()
      expect(creds.userTier).toBeUndefined()
      expect(creds.upgradeUri).toBe(DEFAULT_UPGRADE_URI)
    })

    it('completes OAuth login when credentials service / oauthStore is not present', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      // CredentialsService NOT mounted
      await ctx.plugin(GeminiPlugin, {})

      const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()
        if (urlStr.includes('/device/code')) {
          return new Response(
            JSON.stringify({
              device_code: 'test_dev_code_nostore',
              user_code: 'NO-STORE',
              verification_url: 'https://google.com/device',
              expires_in: 1800,
              interval: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'token_nostore',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('/v1internal:onboardUser')) {
          return new Response(
            JSON.stringify({
              userTier: { id: 'TIER_FREE', name: 'Free' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('Not Found', { status: 404 })
      })
      globalThis.fetch = mockFetch

      const creds = (await ctx.llm.startOAuthLogin('google-gemini')) as OAuthCreds
      expect(creds.token).toBe('token_nostore')
      expect(creds.userTier?.id).toBe('TIER_FREE')
    })
  })

  describe('Model Discovery Registration', () => {
    it('returns default catalog models when unauthenticated (no apiKey or stored credentials)', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(GeminiPlugin, {})

      const models = await ctx.llm.discoverModels('llm-gemini', {
        provider: 'google-gemini',
      })

      expect(models.length).toBe(DEFAULT_GEMINI_MODELS.length)
      expect(models.map(m => m.id)).toEqual(DEFAULT_GEMINI_MODELS.map(m => m.id))
    })

    it('returns default catalog models when oauthStore is present but contains no credential', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MockCredentialsService)
      await ctx.plugin(GeminiPlugin, {})

      // oauthStore is empty
      const models = await ctx.llm.discoverModels('llm-gemini', {
        provider: 'google-gemini',
      })

      expect(models.length).toBe(DEFAULT_GEMINI_MODELS.length)
      expect(models.map(m => m.id)).toEqual(DEFAULT_GEMINI_MODELS.map(m => m.id))
    })

    it('interrogates CloudCodeClient.listModelConfigs when apiKey is provided (handling name-only models and missing limits)', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(GeminiPlugin, {})

      const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()
        if (urlStr.includes('/v1internal:listModelConfigs')) {
          return new Response(
            JSON.stringify({
              modelConfigs: [
                {
                  id: 'models/gemini-2.5-pro',
                  displayName: 'Gemini 2.5 Pro (Custom)',
                  inputTokenLimit: 2_000_000,
                  outputTokenLimit: 131_072,
                },
                {
                  name: 'models/gemini-custom-flash',
                  displayName: '',
                  // inputTokenLimit and outputTokenLimit omitted
                },
                {
                  id: '',
                  name: 'models/gemini-empty-id',
                  displayName: 'Gemini Empty ID',
                },
                {
                  id: 'gemini-bare-id',
                  // displayName and name omitted
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('Not Found', { status: 404 })
      })
      globalThis.fetch = mockFetch

      const models = await ctx.llm.discoverModels('llm-gemini', {
        provider: 'google-gemini',
        apiKey: 'explicit_api_key_123',
      })

      expect(models).toEqual([
        {
          id: 'gemini-2.5-pro',
          name: 'Gemini 2.5 Pro (Custom)',
          contextWindow: 2_000_000,
          maxTokens: 131_072,
        },
        {
          id: 'gemini-custom-flash',
          name: 'models/gemini-custom-flash',
        },
        {
          id: 'gemini-empty-id',
          name: 'Gemini Empty ID',
        },
        {
          id: 'gemini-bare-id',
        },
      ])
    })

    it('reads token from oauthStore across various candidate key properties when apiKey is omitted', async () => {
      const testCases = [
        { stored: { token: 'tok_1' }, expectedToken: 'tok_1' },
        { stored: { accessToken: 'tok_2' }, expectedToken: 'tok_2' },
        { stored: { access_token: 'tok_3' }, expectedToken: 'tok_3' },
        { stored: { key: 'tok_4' }, expectedToken: 'tok_4' },
      ]

      for (const { stored } of testCases) {
        const ctx = new Context()
        await ctx.plugin(LlmRuntime)
        await ctx.plugin(MockCredentialsService)
        await ctx.plugin(GeminiPlugin, {})

        await ctx.get('credentials')?.oauthStore?.modify('google-gemini', () => stored)

        const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
          if (url.toString().includes('/v1internal:listModelConfigs')) {
            return new Response(
              JSON.stringify({
                models: [
                  {
                    name: 'models/gemini-2.5-flash',
                    displayName: 'Gemini 2.5 Flash Discovery',
                    inputTokenLimit: 1_048_576,
                    outputTokenLimit: 65_536,
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
          }
          return new Response('Not Found', { status: 404 })
        })
        globalThis.fetch = mockFetch

        const disc = await ctx.llm.discoverModels('llm-gemini', { provider: 'google-gemini' })
        expect(disc).toEqual([
          {
            id: 'gemini-2.5-flash',
            name: 'Gemini 2.5 Flash Discovery',
            contextWindow: 1_048_576,
            maxTokens: 65_536,
          },
        ])
      }
    })

    it('falls back to default models when credentials service is missing or discovery fails', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      // No credentials service
      await ctx.plugin(GeminiPlugin, {})

      const models1 = await ctx.llm.discoverModels('llm-gemini', { provider: 'google-gemini' })
      expect(models1.map(m => m.id)).toEqual(DEFAULT_GEMINI_MODELS.map(m => m.id))

      // Discovery fetch fails
      const ctx2 = new Context()
      await ctx2.plugin(LlmRuntime)
      await ctx2.plugin(MockCredentialsService)
      await ctx2.plugin(GeminiPlugin, {})
      await ctx2.get('credentials')?.oauthStore?.modify('google-gemini', () => ({ token: 't' }))

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
      const models2 = await ctx2.llm.discoverModels('llm-gemini', { provider: 'google-gemini' })
      expect(models2.map(m => m.id)).toEqual(DEFAULT_GEMINI_MODELS.map(m => m.id))

      // Discovery returns non-200
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('Error', { status: 500 }))
      const models3 = await ctx2.llm.discoverModels('llm-gemini', { provider: 'google-gemini' })
      expect(models3.map(m => m.id)).toEqual(DEFAULT_GEMINI_MODELS.map(m => m.id))
    })
  })

  describe('Settings Section & Adapter Lifecycle', () => {
    it('installs settings section and updates dynamic configuration on change', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MockSettingsProvider)
      await ctx.plugin(GeminiPlugin, {
        subclientType: 'custom-subclient',
      })

      const settings = ctx.get('settings')!
      expect(settings).toBeDefined()

      const descriptor = await settings.describe()
      const geminiNs = descriptor.find(d => d.ns === settingsNamespace('llm-gemini'))
      expect(geminiNs).toBeDefined()
      const geminiVal = geminiNs?.value as Record<string, unknown> | undefined
      expect(geminiVal?.['subclientType']).toBe('custom-subclient')

      // Update settings
      await settings.update(settingsNamespace('llm-gemini'), {
        subclientType: 'updated-subclient',
        apiServerUrl: 'https://custom-api.example.com',
      })

      const updatedDesc = await settings.describe()
      const updatedGemini = updatedDesc.find(d => d.ns === settingsNamespace('llm-gemini'))
      const updatedVal = updatedGemini?.value as Record<string, unknown> | undefined
      expect(updatedVal?.['subclientType']).toBe('updated-subclient')
      expect(updatedVal?.['apiServerUrl']).toBe('https://custom-api.example.com')
    })

    it('delegates credential store reads and mutations via adapter', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MockCredentialsService)
      await ctx.plugin(GeminiPlugin, {})

      // Initial credential with expiring token to trigger adapter auto-refresh and store modify
      await ctx.get('credentials')?.oauthStore?.modify('google-gemini', () => ({
        token: 'expiring_test_token',
        refreshToken: 'valid_refresh_token',
        expiresAt: Date.now() - 1000, // already expired
        projectId: 'gcp-proj-1',
      }))

      const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString()
        if (urlStr.includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'fresh_refreshed_access_token',
              expires_in: 3600,
              refresh_token: 'valid_refresh_token',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (urlStr.includes('streamGenerateContent')) {
          return new Response(
            'data: {"candidates":[{"content":{"parts":[{"text":"Hello from Gemini"}],"role":"model"}}]}\n\n',
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        return new Response('Not Found', { status: 404 })
      })
      globalThis.fetch = mockFetch

      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })) {
        chunks.push(chunk)
      }

      const textChunks = chunks.filter(c => c.type === 'text-delta')
      expect(textChunks.length).toBeGreaterThan(0)
      expect(textChunks[0]?.text).toBe('Hello from Gemini')

      // Verify that credentialStore.modify updated the stored token
      const updatedCreds = await ctx.get('credentials')?.oauthStore?.read('google-gemini')
      expect(updatedCreds?.['token']).toBe('fresh_refreshed_access_token')
    })

    it('handles adapter read/modify safely when credentials service is absent', async () => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      // No credentials service
      await ctx.plugin(GeminiPlugin, {})

      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })) {
        chunks.push(chunk)
      }

      const finishChunk = chunks.find(c => c.type === 'finish')
      expect(finishChunk).toBeDefined()
      if (finishChunk && finishChunk.type === 'finish') {
        expect(finishChunk.reason.kind).toBe('error')
        if (finishChunk.reason.kind === 'error') {
          expect(finishChunk.reason.failure.code).toBe('AUTH')
        }
      }
    })
  })
})
