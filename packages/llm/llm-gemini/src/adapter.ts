/**
 * Google Gemini subscription and Cloud Code PA LLM adapter for DeepSeek Harness.
 * @module @deepseek-ai/dsh-llm-gemini/adapter
 */

import {
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CloudCodeClient } from './cloud-code-client.ts'
import {
  DEFAULT_API_SERVER_URL,
  DEFAULT_IDE_NAME,
  DEFAULT_SUBCLIENT_TYPE,
} from './config.ts'
import { translateGeminiError } from './error.ts'
import { isTokenExpiringSoon, refreshGoogleToken } from './oauth.ts'
import type { GoogleTokenResponse } from './oauth.ts'
import { streamGeminiResponse } from './stream.ts'
import type { UserTier } from './types.ts'

/**
 * Metadata specification for one Gemini model entry in the catalog.
 */
export interface GeminiCatalogModel {
  /** Unique model identifier (e.g. 'gemini-2.5-pro'). */
  readonly id: string
  /** Human-readable model display name. */
  readonly name: string
  /** Descriptive summary of capabilities and ideal use cases. */
  readonly description?: string
  /** Combined input prompt and output completion token capacity. */
  readonly contextWindow: number
  /** Maximum generated token output limit. */
  readonly maxTokens: number
  /** Default output token limit when omitted in request. */
  readonly defaultMaxTokens?: number
  /** Accepted request content modalities (e.g. text, image). */
  readonly inputModalities?: readonly ('text' | 'image')[]
}

/**
 * Canonical default Gemini models offered across subscription tiers.
 */
export const DEFAULT_GEMINI_MODELS: readonly GeminiCatalogModel[] = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    description: 'Most capable model for complex reasoning, coding, and multi-modal tasks',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    defaultMaxTokens: 8_192,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    description: 'Fast and versatile multimodal model for high-frequency agent turns and coding',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    defaultMaxTokens: 8_192,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    description: 'Lightweight high-throughput model optimized for rapid classification and simple tasks',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    defaultMaxTokens: 8_192,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    description: 'Next-generation fast multimodal preview model',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    defaultMaxTokens: 8_192,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    description: 'Next-generation flagship reasoning and coding preview model',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    defaultMaxTokens: 8_192,
    inputModalities: ['text', 'image'],
  },
] as const

/**
 * Resolved credentials for authenticating against Google Gemini and Cloud Code PA.
 */
export interface GeminiCredentials {
  /** OAuth bearer access token. */
  token?: string | undefined
  /** Alternative alias for access token. */
  accessToken?: string | undefined
  /** Target Google Cloud project identifier. */
  projectId?: string | undefined
  /** Alternative alias for project identifier. */
  project?: string | undefined
  /** Refresh token for refreshing expired access tokens. */
  refreshToken?: string | undefined
  /** Expiration epoch timestamp in milliseconds. */
  expiresAt?: number | undefined
  /** Subscription tier details associated with credentials. */
  userTier?: UserTier | null | undefined
}

/**
 * Minimal credential store interface matching `OAuthFileCredentialStore`.
 */
export interface GeminiCredentialStore {
  /**
   * Reads stored credential for a provider.
   * @param providerId - Provider identifier.
   * @returns Stored credential object or undefined.
   */
  read: (providerId: string) => Promise<Record<string, unknown> | undefined>
  /**
   * Modifies stored credential for a provider.
   * @param providerId - Provider identifier.
   * @param fn - Mutation callback.
   * @returns Updated credential object or undefined.
   */
  modify: (
    providerId: string,
    fn: (current: Record<string, unknown> | undefined) =>
      | Promise<Record<string, unknown> | undefined>
      | Record<string, unknown>
      | undefined,
  ) => Promise<Record<string, unknown> | undefined>
}

/**
 * Options for configuring a {@link GeminiAdapter} instance.
 */
export interface GeminiAdapterOptions {
  /** Optional dynamic credential resolver invoked before requests. */
  getCredentials?: ((options?: { signal?: AbortSignal | undefined }) => Promise<GeminiCredentials | undefined>) | undefined
  /** Optional credential store for OAuth credentials retrieval and auto-refresh persistence. */
  credentialStore?: GeminiCredentialStore | undefined
  /** Optional CloudCodeClient instance for entitlement synchronization. */
  cloudCodeClient?: CloudCodeClient | undefined
  /** Base URL for Gemini API server. Defaults to `DEFAULT_API_SERVER_URL`. */
  apiServerUrl?: string | undefined
  /** Subclient type identifier for request metadata. Defaults to `DEFAULT_SUBCLIENT_TYPE`. */
  subclientType?: string | undefined
  /** Client IDE name identifier for User-Agent. Defaults to `DEFAULT_IDE_NAME`. */
  ideName?: string | undefined
  /** Provider route key associated with this adapter. Defaults to `'google-gemini'`. */
  provider?: string | undefined
  /** Advisory models advertised by this adapter. Defaults to `DEFAULT_GEMINI_MODELS`. */
  models?: readonly GeminiCatalogModel[] | undefined
  /** Optional custom fetch implementation for mocking or proxying. */
  fetch?: typeof fetch | undefined
  /** Optional callback invoked when tokens are refreshed during streaming. */
  onTokenRefreshed?: ((token: GoogleTokenResponse) => Promise<void> | void) | undefined
}

/**
 * Deserializes a raw JSON string safely into an object without throwing.
 *
 * @param jsonString - Raw JSON text to parse.
 * @returns Parsed object or wrapped fallback.
 */
function safeJsonParse(jsonString: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(jsonString) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { raw: jsonString }
  }
}

/**
 * Request payload sent to Google Gemini REST API endpoint.
 */
export interface GeminiRequestPayload {
  /** Ordered list of conversation contents with parts. */
  contents: Array<{
    role: 'user' | 'model'
    parts: Array<Record<string, unknown>>
  }>
  /** Optional system instruction payload. */
  systemInstruction?: {
    parts: Array<{ text: string }>
  } | undefined
  /** Optional generation hyperparameters and constraints. */
  generationConfig?: Record<string, unknown> | undefined
  /** Optional tools and function declarations available for model invocation. */
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description: string
      parameters: Record<string, unknown>
    }>
  }> | undefined
}

/**
 * Translates a list of harness {@link Message}s and options into Gemini REST JSON payload format.
 *
 * @param options - Fully assembled generate options.
 * @returns Deserialized Gemini REST request payload object.
 */
export function buildGeminiRequestPayload(options: GenerateOptions): GeminiRequestPayload {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = []
  const systemParts: Array<{ text: string }> = []

  if (options.system && options.system.trim().length > 0) {
    systemParts.push({ text: options.system })
  }

  for (const msg of options.messages) {
    if (msg.role === 'system') {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.trim().length > 0) {
          systemParts.push({ text: block.text })
        }
      }
      continue
    }

    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: Array<Record<string, unknown>> = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          parts.push({ text: block.text })
          break
        case 'reasoning':
          parts.push({ text: block.text })
          break
        case 'image': {
          const att = block.attachment as unknown as Record<string, unknown>
          const mimeType = typeof att.mediaType === 'string' && att.mediaType.length > 0
            ? att.mediaType
            : 'image/png'
          const data = typeof att.data === 'string' ? att.data : ''
          parts.push({
            inlineData: {
              mimeType,
              data,
            },
          })
          break
        }
        case 'tool-call': {
          const argsObj = typeof block.arguments === 'string'
            ? safeJsonParse(block.arguments)
            : block.arguments
          parts.push({
            functionCall: {
              name: block.name,
              args: argsObj,
            },
          })
          break
        }
        case 'tool-result': {
          const textContent = block.content
            .map((c: ContentBlock) => (c.type === 'text' ? c.text : JSON.stringify(c)))
            .join('\n')
          parts.push({
            functionResponse: {
              name: String(block.toolCallId),
              response: {
                output: textContent,
                ...block.isError !== undefined ? { isError: block.isError } : {},
              },
            },
          })
          break
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] })
  }

  const generationConfig: Record<string, unknown> = {}
  if (typeof options.temperature === 'number') {
    generationConfig.temperature = options.temperature
  }
  if (typeof options.maxTokens === 'number') {
    generationConfig.maxOutputTokens = options.maxTokens
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    generationConfig.stopSequences = options.stop
  }
  if (options.reasoningEffort === 'off') {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  let tools: GeminiRequestPayload['tools']
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    tools = [
      {
        functionDeclarations: options.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ]
  }

  return {
    contents,
    ...systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {},
    ...Object.keys(generationConfig).length > 0 ? { generationConfig } : {},
    ...tools !== undefined ? { tools } : {},
  }
}

/**
 * Provider-wire adapter for Google Gemini subscription-based and Cloud Code PA LLM inference.
 */
export class GeminiAdapter extends LlmAdapter {
  /** Configured base endpoint for Gemini API. */
  readonly apiServerUrl: string
  /** Subclient type identifier for API client headers. */
  readonly subclientType: string
  /** Client IDE name for User-Agent headers. */
  readonly ideName: string
  /** Configured models list for catalog and discovery. */
  private readonly models: readonly GeminiCatalogModel[]
  /** Custom fetch implementation when injected. */
  private readonly customFetch: typeof fetch | undefined

  /**
   * Constructs a new {@link GeminiAdapter}.
   *
   * @param options - Configuration and credential resolution options.
   */
  constructor(private readonly options: GeminiAdapterOptions = {}) {
    super()
    this.apiServerUrl = options.apiServerUrl ?? DEFAULT_API_SERVER_URL
    this.subclientType = options.subclientType ?? DEFAULT_SUBCLIENT_TYPE
    this.ideName = options.ideName ?? DEFAULT_IDE_NAME
    this.models = options.models ?? DEFAULT_GEMINI_MODELS
    this.customFetch = options.fetch
  }

  /**
   * Returns the list of models supported and advertised by this adapter.
   *
   * @returns Array of {@link GeminiCatalogModel} specifications.
   */
  modelCatalog(): readonly GeminiCatalogModel[] {
    return this.models
  }

  /**
   * Describe one provider route owned by this adapter.
   *
   * @param provider - Route identifier.
   * @returns Provider display metadata.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Gemini' }
  }

  /**
   * Return the provider-owned retry policy captured with this route.
   *
   * @param _provider - Route identifier.
   * @returns Resolved retry policy or undefined.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * List models this adapter advertises for discovery and selector surfaces.
   *
   * @param provider - Route identifier.
   * @returns Promise resolving to list of {@link LlmModelInfo}.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.modelCatalog().map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description !== undefined ? { description: model.description } : {},
      inputModalities: model.inputModalities ?? ['text', 'image'],
    })))
  }

  /**
   * Resolve detailed metadata and context bounds for one exact model.
   *
   * @param provider - Route identifier.
   * @param model - Model identifier.
   * @param _signal - Optional cancellation signal.
   * @returns Promise resolving to {@link LlmResolvedModelInfo}.
   */
  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const found = this.modelCatalog().find(m => m.id === model)
    if (found) {
      return Promise.resolve({
        provider,
        id: found.id,
        name: found.name,
        ...found.description !== undefined ? { description: found.description } : {},
        context: { contextWindow: found.contextWindow },
        defaultMaxTokens: found.defaultMaxTokens ?? found.maxTokens,
        inputModalities: found.inputModalities ?? ['text', 'image'],
      })
    }

    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 8_192,
      inputModalities: ['text', 'image'],
    })
  }

  /**
   * Resolves authentication credentials, auto-refreshing expired tokens if a refresh token is present.
   *
   * @param signal - Optional cancellation signal.
   * @returns Resolved bearer access token, companion project ID, and user tier.
   */
  private async resolveAuth(signal?: AbortSignal): Promise<{
    token: string
    projectId?: string | undefined
    userTier?: UserTier | null | undefined
  }> {
    let token: string | undefined
    let projectId: string | undefined
    let refreshToken: string | undefined
    let expiresAt: number | undefined
    let userTier: UserTier | null | undefined
    let storeKey: string | undefined

    if (this.options.getCredentials) {
      const creds = await this.options.getCredentials({ signal })
      if (creds) {
        token = creds.token ?? creds.accessToken
        projectId = creds.projectId ?? creds.project
        refreshToken = creds.refreshToken
        expiresAt = creds.expiresAt
        userTier = creds.userTier
      }
    }

    if (!token && this.options.credentialStore) {
      for (const candidateKey of ['google-gemini', 'google']) {
        const stored = await this.options.credentialStore.read(candidateKey)
        if (stored) {
          storeKey = candidateKey
          token = (stored.token as string | undefined)
            ?? (stored.accessToken as string | undefined)
            ?? (stored.access_token as string | undefined)
            ?? (stored.key as string | undefined)
          projectId = (stored.projectId as string | undefined) ?? (stored.project as string | undefined)
          refreshToken = (stored.refreshToken as string | undefined) ?? (stored.refresh_token as string | undefined)
          expiresAt = (stored.expiresAt as number | undefined) ?? (stored.expires_at as number | undefined)
          userTier = stored.userTier as UserTier | null | undefined
          break
        }
      }
    }

    if (!token || token.trim().length === 0) {
      throw new LlmError(
        'Missing Google Gemini authentication credentials. Please authenticate via Google OAuth.',
        'AUTH',
      )
    }

    if (refreshToken && isTokenExpiringSoon({ expiresAt })) {
      const refreshed = await refreshGoogleToken({
        refreshToken,
        signal,
      })
      token = refreshed.access_token

      if (this.options.onTokenRefreshed) {
        await this.options.onTokenRefreshed(refreshed)
      }

      if (this.options.credentialStore && storeKey) {
        await this.options.credentialStore.modify(storeKey, curr => ({
          ...curr,
          token: refreshed.access_token,
          expiresAt: refreshed.expires_at,
          refreshToken: refreshed.refresh_token,
        }))
      }
    }

    return { token, projectId, userTier }
  }

  /**
   * Stream one model inference call as raw harness {@link StreamChunk}s.
   *
   * @param options - Fully assembled generate options.
   * @returns Async generator yielding stream chunks.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { message: 'Gemini stream aborted', code: 'ABORTED' },
        },
      }
      return
    }

    const { token, projectId, userTier } = await this.resolveAuth(options.signal)

    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { message: 'Gemini stream aborted', code: 'ABORTED' },
        },
      }
      return
    }

    const rawModel = options.model || 'gemini-2.5-pro'
    const modelName = rawModel.startsWith('models/') ? rawModel.slice(7) : rawModel
    const baseUrl = this.apiServerUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`

    const payload = buildGeminiRequestPayload(options)

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'x-goog-api-client': `antigravity/${this.subclientType}`,
      'User-Agent': this.ideName,
    }

    if (projectId) {
      headers['x-goog-user-project'] = projectId
    }

    const fetchFn = this.customFetch ?? globalThis.fetch
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        ...options.signal !== undefined ? { signal: options.signal } : {},
      })
    } catch (error) {
      if (options.signal?.aborted) {
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: { message: 'Gemini stream aborted', code: 'ABORTED' },
          },
        }
        return
      }
      throw error
    }

    if (!response.ok) {
      let errorBody: unknown
      try {
        errorBody = await response.text()
      } catch {
        errorBody = response.statusText
      }
      throw translateGeminiError(response.status, errorBody, userTier)
    }

    yield* streamGeminiResponse({
      response,
      signal: options.signal,
      userTier,
    })
  }
}
