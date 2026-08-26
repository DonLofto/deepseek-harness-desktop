/**
 * Unit tests for OpenRouter live model discovery, metadata mapping, caching, and fallback.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '../src/index.ts'
import {
  clearOpenRouterCatalogCache,
  fetchOpenRouterModels,
  mapOpenRouterModel,
  openrouterAttributionHeaders,
  overlayOpenRouterModels,
  parseOpenRouterModalities,
  parseOpenRouterReasoning,
  type OpenRouterApiEntry,
} from '../src/openrouter.ts'
import { discoverModels } from '../src/discovery.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

const KEY_ENV = 'OPENROUTER_API_KEY'

afterEach(async () => {
  clearOpenRouterCatalogCache()
  await closeMockServers()
})

const MOCK_OPENROUTER_RESPONSE = {
  data: [
    {
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Anthropic: Claude 3.5 Sonnet',
      context_length: 200000,
      top_provider: {
        max_completion_tokens: 8192,
      },
      architecture: {
        modality: 'text+image->text',
      },
      supported_parameters: ['tools', 'temperature', 'reasoning'],
    },
    {
      id: 'deepseek/deepseek-r1',
      name: 'DeepSeek: R1',
      context_length: 131072,
      top_provider: {
        max_completion_tokens: 16384,
      },
      architecture: {
        modality: 'text->text',
      },
      supported_parameters: ['tools', 'include_reasoning'],
    },
    {
      id: 'openai/gpt-4o-mini',
      name: 'OpenAI: GPT-4o-mini',
      context_length: 128000,
      max_output_tokens: 4096,
      input: ['text', 'image'],
      supported_parameters: ['tools'],
      pricing: {
        prompt: '0.00000015',
        completion: '0.0000006',
      },
    },
    {
      id: 'meta-llama/llama-3-8b',
      name: 'Meta: Llama 3 8B',
      context_length: 8192,
      max_tokens: 2048,
      architecture: {
        modality: 'text->text',
      },
    },
  ],
}

describe('openrouter metadata mapping', () => {
  it('maps modality correctly from architecture or input fields', () => {
    expect(parseOpenRouterModalities({
      architecture: { modality: 'text+image->text' },
    })).toEqual(['text', 'image'])

    expect(parseOpenRouterModalities({
      architecture: { modality: 'text->text' },
    })).toEqual(['text'])

    expect(parseOpenRouterModalities({
      input: ['text', 'image'],
    })).toEqual(['text', 'image'])

    expect(parseOpenRouterModalities({})).toEqual(['text'])
  })

  it('maps reasoning parameters to thinking levels', () => {
    expect(parseOpenRouterReasoning({
      supported_parameters: ['tools', 'reasoning'],
    })).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        xhigh: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'max',
      },
    })

    expect(parseOpenRouterReasoning({
      supported_parameters: ['include_reasoning'],
    })).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        xhigh: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'max',
      },
    })

    expect(parseOpenRouterReasoning({
      reasoning: true,
    })).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        xhigh: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'max',
      },
    })

    expect(parseOpenRouterReasoning({
      supported_parameters: ['tools', 'temperature'],
    })).toEqual({ reasoning: false })
  })

  it('maps raw OpenRouter entries to Model descriptors', () => {
    const raw: OpenRouterApiEntry = {
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Claude 3.5 Sonnet',
      context_length: 200000,
      top_provider: { max_completion_tokens: 8192 },
      architecture: { modality: 'text+image->text' },
      supported_parameters: ['reasoning'],
    }
    const model = mapOpenRouterModel(raw, 'openrouter', 'https://openrouter.ai/api/v1')
    expect(model).toMatchObject({
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Claude 3.5 Sonnet',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      contextWindow: 200000,
      maxTokens: 8192,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'max',
      },
    })
  })

  it('includes attribution headers', () => {
    const headers = openrouterAttributionHeaders()
    expect(headers['http-referer']).toBe('https://github.com/deepseek-ai/deepseek-harness')
    expect(headers['x-title']).toBe('DeepSeek Harness')
    expect(headers['user-agent']).toBeDefined()
  })
})

describe('openrouter live catalog fetching & caching', () => {
  it('fetches live models and caches them with TTL', async () => {
    const server = await mockServer([
      { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(MOCK_OPENROUTER_RESPONSE) },
    ])

    const models = await fetchOpenRouterModels({
      baseURL: `${server.url}/v1`,
      apiKey: 'sk-test-key',
    })

    expect(models.length).toBe(4)
    expect(models.some(m => m.id === 'anthropic/claude-3.5-sonnet')).toBe(true)
    expect(models.some(m => m.id === 'deepseek/deepseek-r1')).toBe(true)
    expect(server.paths).toEqual(['/v1/models'])
    expect(server.headers[0]?.authorization).toBe('Bearer sk-test-key')

    // Second fetch should hit the in-memory cache without making another network call
    const cachedModels = await fetchOpenRouterModels({
      baseURL: `${server.url}/v1`,
      apiKey: 'sk-test-key',
    })

    expect(cachedModels.length).toBe(4)
    expect(server.paths.length).toBe(1) // Still only 1 network request made
  })

  it('falls back to static catalog if endpoint is unreachable', async () => {
    const models = await fetchOpenRouterModels({
      baseURL: 'http://127.0.0.1:59999/nonexistent',
      timeoutMs: 500,
    })

    // Falls back to static pi-ai catalog models for openrouter
    expect(models.length).toBeGreaterThan(10)
    expect(models.some(m => m.provider === 'openrouter')).toBe(true)
  })

  it('preserves user presets and modelOverrides over live catalog', () => {
    const baseModels = MOCK_OPENROUTER_RESPONSE.data.map(
      r => mapOpenRouterModel(r, 'openrouter', 'https://openrouter.ai/api/v1')!,
    )

    const catalog = overlayOpenRouterModels(baseModels, {
      provider: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultContextWindow: 262144,
      defaultMaxTokens: 32768,
      defaultInput: ['text'],
      modelOverrides: {
        'anthropic/claude-3.5-sonnet': {
          name: 'Custom Claude Name',
          contextWindow: 180000,
        },
      },
      presets: [
        {
          id: '@preset/my-custom-model',
          name: 'My Custom Preset',
          contextWindow: 65536,
          maxTokens: 4096,
          reasoning: true,
        },
      ],
    })

    const overridden = catalog.models.find(m => m.id === 'anthropic/claude-3.5-sonnet')
    expect(overridden?.name).toBe('Custom Claude Name')
    expect(overridden?.contextWindow).toBe(180000)

    const preset = catalog.models.find(m => m.id === '@preset/my-custom-model')
    expect(preset).toBeDefined()
    expect(preset?.name).toBe('My Custom Preset')
    expect(preset?.contextWindow).toBe(65536)
    expect(preset?.reasoning).toBe(true)
  })
})

describe('openrouter discovery in discovery.ts', () => {
  it('interrogates live endpoint for openrouter provider', async () => {
    const server = await mockServer([
      { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(MOCK_OPENROUTER_RESPONSE) },
    ])

    const discovered = await discoverModels({
      provider: 'openrouter',
      baseURL: `${server.url}/v1`,
      apiKey: 'sk-probe-key',
    })

    expect(discovered.length).toBe(4)
    expect(discovered[0]).toEqual({
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Anthropic: Claude 3.5 Sonnet',
      contextWindow: 200000,
      maxTokens: 8192,
    })
    expect(server.paths).toEqual(['/v1/models'])
  })

  it('falls back to static catalog if openrouter live query fails', async () => {
    const server = await mockServer([
      { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"server error"}' },
    ])

    const discovered = await discoverModels({
      provider: 'openrouter',
      baseURL: `${server.url}/v1`,
      apiKey: 'sk-probe-key',
    })

    // Falls back to static catalog
    expect(discovered.length).toBeGreaterThan(10)
  })
})

describe('live catalog integration with PiAiAdapter', () => {
  it('lists dynamic models and resolves reasoning capabilities', async () => {
    const server = await mockServer([
      { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(MOCK_OPENROUTER_RESPONSE) },
    ])

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        openrouter: {
          apiKeyEnv: KEY_ENV,
          baseURL: `${server.url}/v1`,
        },
      },
    })

    const models = await ctx.llm.listModels('openrouter')
    expect(models.length).toBe(4)
    expect(models.some(m => m.id === 'deepseek/deepseek-r1')).toBe(true)

    const resolved = await ctx.llm.resolveModelInfo('openrouter', 'deepseek/deepseek-r1')
    expect(resolved.id).toBe('deepseek/deepseek-r1')
    expect(resolved.name).toBe('DeepSeek: R1')
    expect(resolved.context?.contextWindow).toBe(131072)
    expect(resolved.reasoning).toBeDefined()
    expect(resolved.reasoning?.efforts.length).toBeGreaterThan(0)
  })

  it('merges preset that collides with live model without duplicate metadata errors', async () => {
    const server = await mockServer([
      { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(MOCK_OPENROUTER_RESPONSE) },
    ])

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        openrouter: {
          apiKeyEnv: KEY_ENV,
          baseURL: `${server.url}/v1`,
          presets: [
            {
              id: 'deepseek/deepseek-r1',
              name: 'My Custom DeepSeek R1',
              contextWindow: 200000,
              maxTokens: 16384,
              reasoning: true,
            },
            {
              id: '@preset/custom',
              name: 'Custom Preset',
            },
          ],
        },
      },
    })

    const models = await ctx.llm.listModels('openrouter')
    // 4 live models + 1 unique custom preset = 5 (no duplicate for deepseek/deepseek-r1)
    expect(models.length).toBe(5)
    const seen = new Set(models.map(m => m.id))
    expect(seen.size).toBe(5)

    const resolved = await ctx.llm.resolveModelInfo('openrouter', 'deepseek/deepseek-r1')
    expect(resolved.name).toBe('My Custom DeepSeek R1')
    expect(resolved.context?.contextWindow).toBe(200000)
    expect(resolved.defaultMaxTokens).toBe(16384)

    const gpt4o = await ctx.llm.resolveModelInfo('openrouter', 'openai/gpt-4o-mini')
    expect(gpt4o.cost).toEqual({ input: 0.15, output: 0.6 })
  })
})
