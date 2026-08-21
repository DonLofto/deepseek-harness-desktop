/**
 * Google Gemini subscription and Cloud Code PA LLM provider for DeepSeek Harness.
 * @module @deepseek-ai/dsh-llm-gemini
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
} from '@deepseek-ai/dsh-llm'
import {
  Config,
  resolveGeminiConfig,
  type ResolvedGeminiConfig,
} from './config.ts'
import {
  initiateGoogleDeviceFlow,
  pollGoogleDeviceToken,
} from './oauth.ts'
import { DEFAULT_UPGRADE_URI } from './error.ts'
import { CloudCodeClient } from './cloud-code-client.ts'
import { DEFAULT_GEMINI_MODELS, GeminiAdapter } from './adapter.ts'
import type { UserTier } from './types.ts'

export * from './config.ts'
export * from './oauth.ts'
export * from './cloud-code-client.ts'
export * from './stream.ts'
export * from './error.ts'
export * from './adapter.ts'
export type * from './types.ts'

/** Canonical plugin name for the Google Gemini LLM provider. */
export const name = 'llm-gemini'

/** Service dependencies required by the Gemini LLM plugin. */
export const inject = ['llm']

/** Canonical settings namespace for Gemini configuration. */
const NS = settingsNamespace('llm-gemini')

/** The canonical provider route identifier owned by this plugin. */
export const PROVIDER = 'google-gemini'

/**
 * Applies the Google Gemini LLM provider plugin to the Cordis context.
 *
 * Registers the {@link GeminiAdapter} route, configurable provider directory entry,
 * interactive Google Device Code OAuth login handler, and Cloud Code model discovery.
 *
 * @param ctx - Cordis context runtime instance.
 * @param config - Initial plugin configuration from composition entry.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ResolvedGeminiConfig | undefined

  const resolvedConfig = (): ResolvedGeminiConfig => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveGeminiConfig(raw)
    lastRaw = raw
    memoized = next
    return next
  }
  resolvedConfig()

  const getCloudCodeClient = (): CloudCodeClient => {
    const cfg = resolvedConfig()
    return new CloudCodeClient({
      endpoint: cfg.cloudCodeEndpoint,
      subclientType: cfg.subclientType,
      ideName: cfg.ideName,
    })
  }

  const getOAuthStore = (): import('@deepseek-ai/dsh-credentials').OAuthCredentialStoreLike | undefined => {
    const credsService = ctx.get('credentials')
    return credsService?.oauthStore
  }

  // 1. Configurable Provider Registration
  const providerEntries: readonly LlmConfigurableProvider[] = [
    {
      provider: PROVIDER,
      displayName: 'Google Gemini (Subscription / AI Pro)',
      oauth: true,
      settingsNs: NS,
      settingsPath: [],
      declared: false,
    },
  ]
  ctx.llm.registerConfigurableProviders(providerEntries)

  // 2. OAuth Login Handler Registration
  ctx.llm.registerOAuthLogin(PROVIDER, async (options) => {
    const deviceFlow = await initiateGoogleDeviceFlow({
      signal: options.signal,
    })

    const authUrl = deviceFlow.verification_url || deviceFlow.verification_uri || ''
    options.onAuthUrl?.(authUrl)

    const tokenResponse = await pollGoogleDeviceToken({
      deviceCode: deviceFlow.device_code,
      interval: deviceFlow.interval,
      expiresIn: deviceFlow.expires_in,
      signal: options.signal,
    })

    let userTier: UserTier | undefined
    let projectId: string | undefined

    try {
      const client = getCloudCodeClient()
      const onboard = await client.onboardUser({
        token: tokenResponse.access_token,
        signal: options.signal,
      })
      userTier = onboard.userTier
      projectId = onboard.project ?? (onboard.cloudaicompanionProject ? onboard.cloudaicompanionProject.split('/').pop() : undefined)
    } catch {
      // Graceful fallback if onboard RPC fails
    }

    const upgradeUri = userTier?.upgradeSubscriptionUri ?? DEFAULT_UPGRADE_URI
    const credentialRecord = {
      type: 'oauth',
      token: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: tokenResponse.expires_at,
      projectId,
      userTier,
      upgradeUri,
    }

    const oauthStore = getOAuthStore()
    if (oauthStore) {
      await oauthStore.modify(PROVIDER, () => credentialRecord)
    }

    return credentialRecord
  })

  // 3. Model Discovery Registration
  ctx.llm.registerModelDiscovery(NS, async (request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> => {
    let token: string | undefined = request.apiKey
    if (!token || token.trim().length === 0) {
      const oauthStore = getOAuthStore()
      if (oauthStore) {
        const stored = await oauthStore.read(PROVIDER)
        if (stored) {
          token = (stored.token as string | undefined)
            ?? (stored.accessToken as string | undefined)
            ?? (stored.access_token as string | undefined)
            ?? (stored.key as string | undefined)
        }
      }
    }

    if (token && token.trim().length > 0) {
      try {
        const client = getCloudCodeClient()
        const resp = await client.listModelConfigs({
          token,
          signal: request.signal,
        })
        const configs = resp.modelConfigs ?? resp.models ?? []
        if (configs.length > 0) {
          const validConfigs: LlmDiscoveredModel[] = []
          for (const m of configs) {
            const rawId = m.id || m.name
            if (!rawId) continue
            const id = rawId.startsWith('models/') ? rawId.slice(7) : rawId
            validConfigs.push({
              id,
              ...m.displayName ? { name: m.displayName } : (m.name ? { name: m.name } : {}),
              ...typeof m.inputTokenLimit === 'number' ? { contextWindow: m.inputTokenLimit } : {},
              ...typeof m.outputTokenLimit === 'number' ? { maxTokens: m.outputTokenLimit } : {},
            })
          }
          if (validConfigs.length > 0) {
            return validConfigs
          }
        }
      } catch {
        // Fall back to default catalog models on error
      }
    }

    return DEFAULT_GEMINI_MODELS.map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }))
  })

  // 4. Gemini Adapter Registration
  const adapter = new GeminiAdapter({
    apiServerUrl: resolvedConfig().apiServerUrl,
    subclientType: resolvedConfig().subclientType,
    ideName: resolvedConfig().ideName,
    credentialStore: {
      read: async (id: string) => {
        const store = getOAuthStore()
        return store ? await store.read(id) : undefined
      },
      modify: async (
        id: string,
        fn: (current: Record<string, unknown> | undefined) =>
          | Record<string, unknown>
          | undefined
          | Promise<Record<string, unknown> | undefined>,
      ) => {
        const store = getOAuthStore()
        return store ? await store.modify(id, fn) : undefined
      },
    },
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // 5. Settings Section Installation
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      resolvedConfig()
    },
  })
}
