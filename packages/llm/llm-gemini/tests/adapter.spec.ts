import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CallId,
  createMessage,
  createUserMessage,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  StreamChunk,
  TextBlock,
} from '@deepseek-ai/dsh-llm'
import {
  GeminiAdapter,
  buildGeminiRequestPayload,
} from '../src/adapter.ts'
import type { GeminiCatalogModel, GeminiCredentialStore } from '../src/adapter.ts'

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('modelCatalog & model discovery', () => {
    it('provides default tier models in model catalog', () => {
      const adapter = new GeminiAdapter({
        getCredentials: async () => ({ token: 'test-token', projectId: 'test-proj' }),
      })
      const catalog = adapter.modelCatalog()
      expect(catalog.map(m => m.id)).toContain('gemini-2.5-pro')
      expect(catalog.map(m => m.id)).toContain('gemini-2.5-flash')
      expect(catalog.map(m => m.id)).toContain('gemini-2.5-flash-lite')
      expect(catalog.map(m => m.id)).toContain('gemini-3-flash-preview')
      expect(catalog.map(m => m.id)).toContain('gemini-3.1-pro-preview')
    })

    it('accepts custom models catalog in constructor options', () => {
      const customModels: GeminiCatalogModel[] = [
        {
          id: 'custom-gemini-model',
          name: 'Custom Gemini Model',
          contextWindow: 500_000,
          maxTokens: 16_384,
        },
      ]
      const adapter = new GeminiAdapter({ models: customModels })
      const catalog = adapter.modelCatalog()
      expect(catalog).toEqual(customModels)
    })

    it('lists models with provider metadata via listModels (handling custom inputModalities and defaults)', async () => {
      const adapter = new GeminiAdapter()
      const models = await adapter.listModels('google-gemini')
      expect(models.length).toBeGreaterThan(0)
      expect(models[0]?.provider).toBe('google-gemini')
      expect(models[0]?.id).toBe('gemini-2.5-pro')
      expect(models[0]?.name).toBe('Gemini 2.5 Pro')
      expect(models[0]?.inputModalities).toEqual(['text', 'image'])

      // Test custom models with and without inputModalities
      const customAdapter = new GeminiAdapter({
        models: [
          {
            id: 'no-modalities-model',
            name: 'No Modalities',
            contextWindow: 1000,
            maxTokens: 500,
          },
          {
            id: 'text-only-model',
            name: 'Text Only',
            contextWindow: 1000,
            maxTokens: 500,
            inputModalities: ['text'],
          },
        ],
      })
      const customList = await customAdapter.listModels('google-gemini')
      expect(customList[0]?.description).toBeUndefined()
      expect(customList[0]?.inputModalities).toEqual(['text', 'image'])
      expect(customList[1]?.inputModalities).toEqual(['text'])
    })

    it('resolves known model with exact context and limits via resolveModel', async () => {
      const adapter = new GeminiAdapter()
      const resolved = await adapter.resolveModel('google-gemini', 'gemini-2.5-pro')
      expect(resolved.id).toBe('gemini-2.5-pro')
      expect(resolved.name).toBe('Gemini 2.5 Pro')
      expect(resolved.context?.contextWindow).toBe(1_048_576)
      expect(resolved.defaultMaxTokens).toBe(8_192)
      expect(resolved.inputModalities).toEqual(['text', 'image'])

      // Custom model without description or defaultMaxTokens
      const customAdapter = new GeminiAdapter({
        models: [
          {
            id: 'custom-no-defaults',
            name: 'Custom No Defaults',
            contextWindow: 200_000,
            maxTokens: 10_000,
          },
        ],
      })
      const customResolved = await customAdapter.resolveModel('google-gemini', 'custom-no-defaults')
      expect(customResolved.description).toBeUndefined()
      expect(customResolved.defaultMaxTokens).toBe(10_000)
    })

    it('resolves unknown model with fallback defaults via resolveModel', async () => {
      const adapter = new GeminiAdapter()
      const resolved = await adapter.resolveModel('google-gemini', 'unknown-future-model')
      expect(resolved.id).toBe('unknown-future-model')
      expect(resolved.name).toBe('unknown-future-model')
      expect(resolved.context?.contextWindow).toBe(1_048_576)
      expect(resolved.defaultMaxTokens).toBe(8_192)
    })

    it('provides providerInfo and providerRetryPolicy', () => {
      const adapter = new GeminiAdapter()
      expect(adapter.providerInfo('google-gemini')).toEqual({
        id: 'google-gemini',
        name: 'Google Gemini',
      })
      expect(adapter.providerRetryPolicy('google-gemini')).toBeUndefined()
    })
  })

  describe('buildGeminiRequestPayload', () => {
    it('converts user text messages and system instructions', () => {
      const userMsg = createUserMessage({
        content: [{ type: 'text', text: 'Hello, what is the weather?' }],
        source: { kind: 'user' },
      })
      const payload = buildGeminiRequestPayload({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [userMsg],
        system: 'You are a helpful assistant.',
        temperature: 0.7,
        maxTokens: 2048,
        stop: ['STOP_HERE'],
      })

      expect(payload.systemInstruction).toEqual({
        parts: [{ text: 'You are a helpful assistant.' }],
      })
      expect(payload.contents).toEqual([
        {
          role: 'user',
          parts: [{ text: 'Hello, what is the weather?' }],
        },
      ])
      expect(payload.generationConfig).toEqual({
        temperature: 0.7,
        maxOutputTokens: 2048,
        stopSequences: ['STOP_HERE'],
      })
    })

    it('handles system role message in history and thinking reasoning effort', () => {
      const sysMsg = createMessage({
        role: 'system',
        content: [
          { type: 'text', text: 'System rule: be concise.' },
          { type: 'text', text: '   ' }, // empty text block
          { type: 'reasoning', text: 'hidden' } as unknown as TextBlock, // non-text block in system
        ],
        source: { kind: 'user' },
      })
      const userMsg = createUserMessage({
        content: [{ type: 'text', text: 'Hi' }],
        source: { kind: 'user' },
      })
      const payload = buildGeminiRequestPayload({
        provider: 'google-gemini',
        model: 'gemini-2.5-flash',
        messages: [sysMsg, userMsg],
        system: 'Base system prompt.',
        reasoningEffort: ReasoningEffortId('off'),
      })

      expect(payload.systemInstruction).toEqual({
        parts: [
          { text: 'Base system prompt.' },
          { text: 'System rule: be concise.' },
        ],
      })
      expect(payload.generationConfig).toEqual({
        thinkingConfig: { thinkingBudget: 0 },
      })
    })

    it('converts assistant message with text, reasoning, and tool calls (including edge case arguments)', () => {
      const assistantMsg = createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Analyzing query...' },
          { type: 'text', text: 'I will call a tool.' },
          {
            type: 'tool-call',
            id: CallId('call_123'),
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
          {
            type: 'tool-call',
            id: CallId('call_arr'),
            name: 'get_items',
            arguments: '[1, 2, 3]',
          },
          {
            type: 'tool-call',
            id: CallId('call_invalid'),
            name: 'broken_tool',
            arguments: '{invalid_json',
          },
          {
            type: 'tool-call',
            id: CallId('call_obj'),
            name: 'obj_tool',
            arguments: { direct: true } as unknown as string,
          },
        ],
        source: { kind: 'model', provider: 'google-gemini', model: 'gemini-2.5-pro' },
      })

      const payload = buildGeminiRequestPayload({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [assistantMsg],
      })

      expect(payload.contents).toEqual([
        {
          role: 'model',
          parts: [
            { text: 'Analyzing query...' },
            { text: 'I will call a tool.' },
            {
              functionCall: {
                name: 'get_weather',
                args: { city: 'Paris' },
              },
            },
            {
              functionCall: {
                name: 'get_items',
                args: { value: [1, 2, 3] },
              },
            },
            {
              functionCall: {
                name: 'broken_tool',
                args: { raw: '{invalid_json' },
              },
            },
            {
              functionCall: {
                name: 'obj_tool',
                args: { direct: true },
              },
            },
          ],
        },
      ])
    })

    it('converts tool result messages with both isError defined and omitted', () => {
      const toolResultWithErr = createMessage({
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: CallId('get_weather'),
            content: [
              { type: 'text', text: '22 degrees and sunny' },
              { type: 'reasoning', text: 'extra details' } as unknown as ContentBlock,
            ],
            isError: true,
          },
        ],
        source: { kind: 'tool', callId: CallId('get_weather') },
      })

      const toolResultWithoutErr = createMessage({
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: CallId('get_time'),
            content: [{ type: 'text', text: '12:00 PM' }],
          },
        ],
        source: { kind: 'tool', callId: CallId('get_time') },
      })

      const emptyContentMsg = createMessage({
        role: 'user',
        content: [],
        source: { kind: 'user' },
      })

      const payload = buildGeminiRequestPayload({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [emptyContentMsg, toolResultWithErr, toolResultWithoutErr],
      })

      expect(payload.contents).toEqual([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: {
                  output: '22 degrees and sunny\n{"type":"reasoning","text":"extra details"}',
                  isError: true,
                },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_time',
                response: {
                  output: '12:00 PM',
                },
              },
            },
          ],
        },
      ])
    })

    it('handles image blocks and tools in generation options', () => {
      type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']
      const imageRef: ImageRef = {
        attachmentId: 'att_1' as ImageRef['attachmentId'],
        mediaType: 'image/jpeg',
        bytes: 100,
        width: 10,
        height: 10,
      }
      const emptyImageRef: ImageRef = {
        attachmentId: 'att_2' as ImageRef['attachmentId'],
        mediaType: '' as ImageRef['mediaType'],
        bytes: 0,
        width: 0,
        height: 0,
      }
      const userMsgWithImage = createUserMessage({
        content: [
          { type: 'text', text: 'Describe this image' },
          {
            type: 'image',
            attachment: {
              ...imageRef,
              data: 'base64imagedata',
            } as ImageRef,
          },
          {
            type: 'image',
            attachment: emptyImageRef,
          },
        ],
        source: { kind: 'user' },
      })

      const payload = buildGeminiRequestPayload({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [userMsgWithImage],
        tools: [
          {
            name: 'fetch_data',
            description: 'Fetch external data',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      })

      const firstContent = payload.contents[0]
      expect(firstContent?.parts[1]).toEqual({
        inlineData: {
          mimeType: 'image/jpeg',
          data: 'base64imagedata',
        },
      })
      expect(firstContent?.parts[2]).toEqual({
        inlineData: {
          mimeType: 'image/png',
          data: '',
        },
      })
      expect(payload.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'fetch_data',
              description: 'Fetch external data',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      ])
    })

    it('provides empty user message part if contents are empty', () => {
      const payload = buildGeminiRequestPayload({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [],
      })
      expect(payload.contents).toEqual([
        {
          role: 'user',
          parts: [{ text: '' }],
        },
      ])
    })
  })

  describe('streaming inference turns', () => {
    it('dispatches request with proper endpoint, headers, and yields stream chunks using globalThis.fetch', async () => {
      const ssePayload = [
        'data: ' + JSON.stringify({
          candidates: [{
            content: {
              parts: [{ text: 'Hello world from Gemini!' }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        }),
        '\n\n',
      ].join('')

      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(ssePayload, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
      globalThis.fetch = mockFetch

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({
          accessToken: 'mock-access-token',
          project: 'my-companion-project',
          expiresAt: Date.now() + 100_000_000,
        }),
      })

      const userMsg = createUserMessage({
        content: [{ type: 'text', text: 'Hello' }],
        source: { kind: 'user' },
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'google-gemini',
        model: '', // test empty model fallback
        messages: [userMsg],
      })) {
        chunks.push(chunk)
      }

      const calls = mockFetch.mock.calls as Array<[string, RequestInit | undefined]>
      expect(calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
      const headers = (calls[0]?.[1]?.headers as Record<string, string> | undefined) ?? {}
      expect(headers['Authorization']).toBe('Bearer mock-access-token')
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['x-goog-api-client']).toBe('antigravity/hub')
      expect(headers['User-Agent']).toBe('antigravity')
      expect(headers['x-goog-user-project']).toBe('my-companion-project')

      expect(chunks.some(c => c.type === 'block-start' && c.blockType === 'text')).toBe(true)
      expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Hello world from Gemini!')).toBe(true)
      expect(chunks.some(c => c.type === 'block-end')).toBe(true)
      expect(chunks.some(c => c.type === 'usage')).toBe(true)
      expect(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop')).toBe(true)
    })

    it('strips models/ prefix if passed in model option', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({ token: 'mock-token' }),
        fetch: mockFetch,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'models/gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      for await (const _chunk of generator) {
        // consume
      }

      const calls = mockFetch.mock.calls as Array<[string, RequestInit | undefined]>
      expect(calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    })

    it('throws LlmError when credentials are missing or empty', async () => {
      const adapter = new GeminiAdapter({
        getCredentials: async () => undefined,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      await expect(async () => {
        for await (const _ of generator) {
          // consume
        }
      }).rejects.toThrow(LlmError)
    })

    it('refreshes token when expired or expiring soon before streaming', async () => {
      const mockRefresh = vi.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-fresh-access-token',
          expires_in: 3600,
          refresh_token: 'still-valid-refresh-token',
        }),
      } as unknown as Response)

      const mockSse = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('data: {"candidates":[{"content":{"parts":[{"text":"Refreshed!"}]}}]}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )

      globalThis.fetch = mockRefresh

      const onTokenRefreshed = vi.fn()

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({
          token: 'expired-access-token',
          refreshToken: 'valid-refresh-token',
          expiresAt: Date.now() - 1000, // expired
        }),
        onTokenRefreshed,
        fetch: mockSse,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-flash',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      for await (const _ of generator) {
        // consume
      }

      expect(onTokenRefreshed).toHaveBeenCalled()
      const calls = mockSse.mock.calls as Array<[string, RequestInit | undefined]>
      const headers = (calls[0]?.[1]?.headers as Record<string, string> | undefined) ?? {}
      expect(headers['Authorization']).toBe('Bearer new-fresh-access-token')
    })

    it('reads credentials from google fallback key and aliases in credentialStore (with new refresh_token)', async () => {
      let storedCreds: Record<string, unknown> = {
        type: 'oauth',
        key: 'key-token',
        refresh_token: 'refresh-abc',
        expires_at: Date.now() - 5000,
        project: 'google-proj',
      }

      const mockStore: GeminiCredentialStore = {
        read: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'google') return storedCreds
          return undefined
        }),
        modify: vi.fn().mockImplementation(async (
          _id: string,
          fn: (current: Record<string, unknown> | undefined) =>
            | Promise<Record<string, unknown> | undefined>
            | Record<string, unknown>
            | undefined,
        ) => {
          const res = await fn(storedCreds)
          if (res) storedCreds = res
          return storedCreds
        }),
      }

      globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'store-refreshed-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
      } as unknown as Response)

      const mockSseFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('data: {"candidates":[{"content":{"parts":[{"text":"Ok"}]}}]}\n\n', {
          status: 200,
        }),
      )

      const adapter = new GeminiAdapter({
        credentialStore: mockStore,
        fetch: mockSseFetch,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-flash',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      for await (const _ of generator) {
        // consume
      }

      expect(mockStore.modify).toHaveBeenCalledWith('google', expect.any(Function))
      expect(storedCreds['token']).toBe('store-refreshed-token')
      expect(storedCreds['refreshToken']).toBe('new-refresh-token')
    })

    it('reads credentials from google-gemini key in credentialStore (without new refresh_token)', async () => {
      let storedCreds: Record<string, unknown> = {
        type: 'oauth',
        token: 'old-token',
        refreshToken: 'orig-refresh-token',
        expiresAt: Date.now() - 5000,
      }

      const mockStore: GeminiCredentialStore = {
        read: vi.fn().mockResolvedValue(storedCreds),
        modify: vi.fn().mockImplementation(async (
          _id: string,
          fn: (current: Record<string, unknown> | undefined) =>
            | Promise<Record<string, unknown> | undefined>
            | Record<string, unknown>
            | undefined,
        ) => {
          const res = await fn(storedCreds)
          if (res) storedCreds = res
          return storedCreds
        }),
      }

      globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'fresh-store-token',
          expires_in: 3600,
        }),
      } as unknown as Response)

      const mockSseFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('data: {"candidates":[{"content":{"parts":[{"text":"Ok"}]}}]}\n\n', {
          status: 200,
        }),
      )

      const adapter = new GeminiAdapter({
        credentialStore: mockStore,
        fetch: mockSseFetch,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-flash',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      for await (const _ of generator) {
        // consume
      }

      expect(mockStore.modify).toHaveBeenCalledWith('google-gemini', expect.any(Function))
      expect(storedCreds['token']).toBe('fresh-store-token')
      expect(storedCreds['refreshToken']).toBe('orig-refresh-token')
    })

    it('handles pre-flight abort signal cleanly', async () => {
      const abortController = new AbortController()
      abortController.abort()

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({ token: 'mock-token' }),
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
        signal: abortController.signal,
      })) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([
        {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: {
              message: 'Gemini stream aborted',
              code: 'ABORTED',
            },
          },
        },
      ])
    })

    it('handles post-auth abort signal cleanly', async () => {
      const abortController = new AbortController()

      const adapter = new GeminiAdapter({
        getCredentials: async () => {
          abortController.abort()
          return { token: 'mock-token' }
        },
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
        signal: abortController.signal,
      })) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([
        {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: {
              message: 'Gemini stream aborted',
              code: 'ABORTED',
            },
          },
        },
      ])
    })

    it('handles in-flight network abort cleanly', async () => {
      const abortController = new AbortController()

      const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        abortController.abort()
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      })

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({ token: 'mock-token' }),
        fetch: mockFetch,
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
        signal: abortController.signal,
      })) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([
        {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: {
              message: 'Gemini stream aborted',
              code: 'ABORTED',
            },
          },
        },
      ])
    })

    it('propagates non-abort network fetch errors', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network offline'))

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({ token: 'mock-token' }),
        fetch: mockFetch,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      await expect(async () => {
        for await (const _ of generator) {
          // consume
        }
      }).rejects.toThrow('Network offline')
    })

    it('translates HTTP 402 quota error with actionable upgrade URL', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Quota exceeded for subscription tier',
            },
          }),
          { status: 402, statusText: 'Payment Required' },
        ),
      )

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({
          token: 'mock-token',
          userTier: {
            id: 'AGY_BUSINESS',
            name: 'Business',
            upgradeSubscriptionUri: 'https://console.cloud.google.com/billing',
          },
        }),
        fetch: mockFetch,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      try {
        for await (const _ of generator) {
          // consume
        }
        expect.unreachable('expected stream to throw on HTTP 402')
      } catch (err) {
        expect((err as LlmError).code).toBe('QUOTA_EXHAUSTED')
        expect((err as LlmError).failure.status).toBe(402)
      }
    })

    it('handles response where text() throws and falls back to statusText', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => {
          throw new Error('cannot read body stream')
        },
      } as unknown as Response)

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({ token: 'mock-token' }),
        fetch: mockFetch,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      try {
        for await (const _ of generator) {
          // consume
        }
        expect.unreachable('expected stream to throw on HTTP 500')
      } catch (err) {
        expect((err as LlmError).code).toBe('SERVER')
      }
    })

    it('translates HTTP 429 rate limit error', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'Too many requests' },
          }),
          { status: 429 },
        ),
      )

      const adapter = new GeminiAdapter({
        getCredentials: async () => ({ token: 'mock-token' }),
        fetch: mockFetch,
      })

      const generator = adapter.stream({
        provider: 'google-gemini',
        model: 'gemini-2.5-pro',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })],
      })

      try {
        for await (const _ of generator) {
          // consume
        }
        expect.unreachable('expected stream to throw on HTTP 429')
      } catch (err) {
        expect((err as LlmError).code).toBe('RATE_LIMIT')
      }
    })
  })
})
