/**
 * Dynamic catalog fetcher, metadata mapping, and caching for OpenRouter models.
 *
 * Interrogates `GET https://openrouter.ai/api/v1/models` using the configured
 * API key and attribution headers. Maps OpenRouter capabilities (context length,
 * max completion tokens, vision modality, reasoning support) into pi-ai `Model<Api>`
 * descriptors, with in-memory TTL caching and offline fallback to the bundled static
 * catalog.
 *
 * @module dsh-llm-pi-ai/openrouter
 */

import type { Api, Model, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { attributionHeaders, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { catalogModels, NO_COST, type PiAiModality, type RouteCatalog, type RouteCatalogRequest } from './catalog.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './config.ts'

/** Default OpenRouter base URL. */
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Default cache TTL for dynamic OpenRouter catalog (1 hour). */
export const DEFAULT_OPENROUTER_CACHE_TTL_MS = 60 * 60 * 1000

/** Maximum response body size for OpenRouter model listing (8 MB). */
const MAX_OPENROUTER_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * OpenRouter attribution headers sent on live catalog queries.
 * @returns attribution headers record.
 */
export function openrouterAttributionHeaders(): Record<string, string> {
  return {
    'http-referer': 'https://github.com/deepseek-ai/deepseek-harness',
    'x-title': 'DeepSeek Harness',
    ...attributionHeaders(),
  }
}

/** Raw OpenRouter model entry returned by `GET /api/v1/models`. */
export interface OpenRouterApiEntry {
  id?: unknown
  name?: unknown
  description?: unknown
  context_length?: unknown
  contextWindow?: unknown
  architecture?: {
    modality?: unknown
    tokenizer?: unknown
    instruct_type?: unknown
  } | null
  top_provider?: {
    max_completion_tokens?: unknown
    is_moderated?: unknown
  } | null
  max_output_tokens?: unknown
  max_tokens?: unknown
  input?: unknown
  supported_parameters?: unknown
  reasoning?: unknown
}

/** Cached catalog entry with timestamp. */
interface CacheEntry {
  models: readonly Model<Api>[]
  fetchedAt: number
}

/** In-memory cache by baseURL. */
const catalogCache = new Map<string, CacheEntry>()

/** Dynamic model cache for active providers: provider route -> models. */
const activeProviderModels = new Map<string, readonly Model<Api>[]>()

/** Clear all cached OpenRouter catalog data (useful for tests). */
export function clearOpenRouterCatalogCache(): void {
  catalogCache.clear()
  activeProviderModels.clear()
}

/**
 * Register the active models for a provider route so `getModels()` and model resolution
 * can read them dynamically.
 * @param provider - provider route key.
 * @param models - materialized models list.
 */
export function setActiveProviderModels(provider: string, models: readonly Model<Api>[]): void {
  activeProviderModels.set(provider, models)
}

/**
 * Get the currently active models for a provider route, falling back to static models if unset.
 * @param provider - provider route key.
 * @param fallback - static fallback models list.
 * @returns the active or fallback models.
 */
export function getActiveProviderModels(provider: string, fallback: readonly Model<Api>[]): readonly Model<Api>[] {
  return activeProviderModels.get(provider) ?? fallback
}

/** Helper to extract a positive integer capacity. */
function parseCapacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** Helper to extract a non-empty string label. */
function parseLabel(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Map OpenRouter modality metadata to pi-ai request modalities.
 * @param entry - raw OpenRouter entry.
 * @returns mapped modalities list.
 */
export function parseOpenRouterModalities(entry: OpenRouterApiEntry): PiAiModality[] {
  if (Array.isArray(entry.input)) {
    const valid = entry.input.filter((m): m is PiAiModality => m === 'text' || m === 'image')
    if (valid.length > 0) return valid
  }
  const modality = typeof entry.architecture?.modality === 'string'
    ? entry.architecture.modality.toLowerCase()
    : ''
  if (modality.includes('image')) {
    return ['text', 'image']
  }
  return ['text']
}

/** Standard OpenRouter thinking level map when reasoning is enabled. */
const OPENROUTER_THINKING_LEVEL_MAP: ThinkingLevelMap = {
  minimal: null,
  xhigh: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

/**
 * Map OpenRouter reasoning capability from supported_parameters or reasoning flag.
 * @param entry - raw OpenRouter entry.
 * @returns reasoning capability facts.
 */
export function parseOpenRouterReasoning(entry: OpenRouterApiEntry): {
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
} {
  if (entry.reasoning === true) {
    return {
      reasoning: true,
      thinkingLevelMap: OPENROUTER_THINKING_LEVEL_MAP,
    }
  }
  if (Array.isArray(entry.supported_parameters)) {
    const params = entry.supported_parameters.map(p => String(p).toLowerCase())
    if (params.includes('reasoning') || params.includes('include_reasoning')) {
      return {
        reasoning: true,
        thinkingLevelMap: OPENROUTER_THINKING_LEVEL_MAP,
      }
    }
  }
  return { reasoning: false }
}

/**
 * Map a raw OpenRouter API entry to a pi-ai `Model<Api>`.
 * @param entry - raw OpenRouter entry.
 * @param provider - provider route key.
 * @param baseUrl - endpoint base URL.
 * @returns mapped model descriptor or undefined when unusable.
 */
export function mapOpenRouterModel(
  entry: OpenRouterApiEntry,
  provider: string,
  baseUrl: string,
): Model<Api> | undefined {
  const id = parseLabel(entry.id)
  if (id === undefined) return undefined
  const name = parseLabel(entry.name) ?? id
  const contextWindow = parseCapacity(entry.context_length, entry.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = parseCapacity(
    entry.top_provider?.max_completion_tokens,
    entry.max_output_tokens,
    entry.max_tokens,
  ) ?? DEFAULT_MAX_TOKENS
  const input = parseOpenRouterModalities(entry)
  const reasoning = parseOpenRouterReasoning(entry)

  return {
    id,
    name,
    api: 'openai-completions',
    provider,
    baseUrl,
    input,
    cost: NO_COST,
    contextWindow,
    maxTokens,
    ...reasoning,
  }
}

/** Options for fetching OpenRouter live catalog. */
export interface FetchOpenRouterOptions {
  apiKey?: string | undefined
  baseURL?: string | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  ttlMs?: number | undefined
  forceRefresh?: boolean | undefined
  provider?: string | undefined
}

/**
 * Read bounded stream from response body.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_OPENROUTER_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_OPENROUTER_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_OPENROUTER_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Fetch and parse raw OpenRouter model listings from the network.
 * @param options - request options including apiKey, baseURL, and signal.
 * @returns parsed raw OpenRouter API entries.
 */
export async function queryOpenRouterModelsEndpoint(
  options: FetchOpenRouterOptions = {},
): Promise<readonly OpenRouterApiEntry[]> {
  const rawBaseUrl = options.baseURL ?? DEFAULT_OPENROUTER_BASE_URL
  const baseURL = rawBaseUrl.replace(/\/+$/, '')
  const url = `${baseURL}/models`
  const keyCheck = options.apiKey !== undefined && options.apiKey.length > 0
    ? normalizeApiKey(options.apiKey)
    : undefined
  const apiKey = keyCheck?.ok ? keyCheck.value : undefined

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...openrouterAttributionHeaders(),
    ...apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {},
  }

  const timeoutMs = options.timeoutMs ?? 15_000
  const timeoutController = new AbortController()
  const timer = setTimeout(() => { timeoutController.abort() }, timeoutMs)
  const signal = options.signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([options.signal, timeoutController.signal])

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal,
    })
    if (!response.ok) {
      throw new LlmError(`OpenRouter catalog fetch failed with HTTP ${response.status}`, 'DISCOVERY_FAILED')
    }
    const text = await readBounded(response, url)
    const json = JSON.parse(text) as { data?: unknown }
    if (!Array.isArray(json?.data)) {
      throw new LlmError('OpenRouter models listing has no "data" array', 'DISCOVERY_FAILED')
    }
    return json.data as OpenRouterApiEntry[]
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch OpenRouter models with TTL caching and fallback to static catalog.
 * @param options - request options including apiKey, baseURL, ttlMs, and signal.
 * @returns mapped pi-ai model descriptors.
 */
export async function fetchOpenRouterModels(
  options: FetchOpenRouterOptions = {},
): Promise<readonly Model<Api>[]> {
  const provider = options.provider ?? 'openrouter'
  const baseURL = (options.baseURL ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, '')
  const ttlMs = options.ttlMs ?? DEFAULT_OPENROUTER_CACHE_TTL_MS
  const cacheKey = `${provider}:${baseURL}`

  const cached = catalogCache.get(cacheKey)
  const now = Date.now()
  if (!options.forceRefresh && cached !== undefined && (now - cached.fetchedAt < ttlMs)) {
    return cached.models
  }

  try {
    const entries = await queryOpenRouterModelsEndpoint(options)
    const models: Model<Api>[] = []
    for (const raw of entries) {
      const model = mapOpenRouterModel(raw, provider, baseURL)
      if (model !== undefined) models.push(model)
    }
    if (models.length > 0) {
      catalogCache.set(cacheKey, { models, fetchedAt: now })
      return models
    }
  } catch {
    // Return stale cache if available
    if (cached !== undefined) {
      return cached.models
    }
  }

  // Fallback to static bundled catalog
  const staticCatalog = catalogModels(provider)
  if (staticCatalog.size > 0) {
    return [...staticCatalog.values()]
  }
  return []
}

/**
 * Fetch OpenRouter models as `LlmDiscoveredModel[]` for discovery UI ("Fetch available models").
 * @param options - request options including apiKey, baseURL, and signal.
 * @returns candidate discovered models list.
 */
export async function fetchOpenRouterDiscovery(
  options: FetchOpenRouterOptions = {},
): Promise<readonly LlmDiscoveredModel[]> {
  try {
    const entries = await queryOpenRouterModelsEndpoint(options)
    const models: LlmDiscoveredModel[] = []
    for (const entry of entries) {
      const id = parseLabel(entry.id)
      if (id === undefined) continue
      const name = parseLabel(entry.name) ?? id
      const contextWindow = parseCapacity(entry.context_length, entry.contextWindow)
      const maxTokens = parseCapacity(
        entry.top_provider?.max_completion_tokens,
        entry.max_output_tokens,
        entry.max_tokens,
      )
      models.push({
        id,
        name,
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
      })
    }
    if (models.length > 0) return models
  } catch {
    // Fall back to bundled static catalog
    const provider = options.provider ?? 'openrouter'
    const staticCatalog = catalogModels(provider)
    if (staticCatalog.size > 0) {
      return [...staticCatalog.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
    }
  }
  return []
}

/**
 * Overlay user presets and modelOverrides on top of live or fallback OpenRouter models.
 * @param baseModels - base live or static catalog models.
 * @param request - route catalog configuration request.
 * @returns materialized route catalog with configured max tokens.
 */
export function overlayOpenRouterModels(
  baseModels: readonly Model<Api>[],
  request: RouteCatalogRequest,
): RouteCatalog {
  const provider = request.provider
  const baseURL = request.baseURL ?? DEFAULT_OPENROUTER_BASE_URL
  const overrides = request.modelOverrides ?? {}
  const presets = request.presets ?? []
  const configured = request.models ?? []

  // If explicit models list was configured, it replaces the base catalog
  if (configured.length > 0) {
    const seen = new Set<string>()
    const configuredMaxTokens = new Map<string, number>()
    const models = [...configured, ...presets].map((entry) => {
      if (seen.has(entry.id)) {
        throw new Error(`llm-pi-ai: provider "${provider}" lists model "${entry.id}" more than once`)
      }
      seen.add(entry.id)
      const base = baseModels.find(m => m.id === entry.id)
      const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow
      const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens
      if (entry.maxTokens !== undefined) configuredMaxTokens.set(entry.id, entry.maxTokens)

      return {
        ...base,
        id: entry.id,
        name: entry.name ?? base?.name ?? entry.id,
        api: request.api ?? base?.api ?? 'openai-completions',
        provider,
        baseUrl: baseURL,
        input: entry.input ?? base?.input ?? [...request.defaultInput],
        cost: base?.cost ?? NO_COST,
        contextWindow,
        maxTokens,
        reasoning: entry.reasoning ?? base?.reasoning ?? false,
      } as Model<Api>
    })
    return { models, configuredMaxTokens }
  }

  // Base live models + overrides
  const configuredMaxTokens = new Map<string, number>()
  const overridden = baseModels.map((base) => {
    const override = overrides[base.id]
    if (override === undefined) return base
    if (override.maxTokens !== undefined) configuredMaxTokens.set(base.id, override.maxTokens)
    return {
      ...base,
      name: override.name ?? base.name,
      contextWindow: override.contextWindow ?? base.contextWindow,
      maxTokens: override.maxTokens ?? base.maxTokens,
      input: override.input ?? base.input,
      reasoning: override.reasoning ?? base.reasoning,
    } as Model<Api>
  })

  // Append custom presets (e.g. @preset/...)
  const presetModels: Model<Api>[] = presets.map((preset) => {
    if (preset.maxTokens !== undefined) configuredMaxTokens.set(preset.id, preset.maxTokens)
    return {
      id: preset.id,
      name: preset.name ?? preset.id,
      api: request.api ?? 'openai-completions',
      provider,
      baseUrl: baseURL,
      input: preset.input ?? [...request.defaultInput],
      cost: NO_COST,
      contextWindow: preset.contextWindow ?? request.defaultContextWindow,
      maxTokens: preset.maxTokens ?? request.defaultMaxTokens,
      reasoning: preset.reasoning ?? false,
      ...(preset.reasoning === true ? { thinkingLevelMap: OPENROUTER_THINKING_LEVEL_MAP } : {}),
    } as Model<Api>
  })

  return {
    models: [...overridden, ...presetModels],
    configuredMaxTokens,
  }
}
