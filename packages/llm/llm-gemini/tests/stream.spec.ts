import { describe, it, expect, vi } from 'vitest'
import {
  parseGeminiStreamChunk,
  streamGeminiResponse,
  mapGeminiFinishReason,
  mapGeminiUsage,
} from '../src/stream.ts'
import {
  translateGeminiError,
  DEFAULT_UPGRADE_URI,
} from '../src/error.ts'
import { LlmError, EMPTY_RESPONSE_CODE, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { UserTier } from '../src/types.ts'

describe('Gemini Stream Chunk Parser (parseGeminiStreamChunk)', () => {
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

  it('extracts text parts with thought flag as thoughts', () => {
    const chunk = JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: 'Initial reasoning step.', thought: true },
            { text: 'Actual output text.' },
          ],
        },
      }],
    })
    const parsed = parseGeminiStreamChunk(chunk)
    expect(parsed.thought).toBe('Initial reasoning step.')
    expect(parsed.text).toBe('Actual output text.')
  })

  it('extracts function and tool calls from candidate parts', () => {
    const chunk = JSON.stringify({
      candidates: [{
        content: {
          parts: [
            {
              functionCall: {
                name: 'search_files',
                args: { query: 'parseGemini' },
                id: 'call_abc123',
              },
            },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 45,
        totalTokenCount: 165,
        cachedContentTokenCount: 20,
        thoughtsTokenCount: 15,
      },
    })
    const parsed = parseGeminiStreamChunk(chunk)
    expect(parsed.toolCalls).toEqual([
      {
        id: 'call_abc123',
        name: 'search_files',
        args: { query: 'parseGemini' },
      },
    ])
    expect(parsed.finishReason).toBe('STOP')
    expect(parsed.usage).toEqual({
      promptTokenCount: 120,
      candidatesTokenCount: 45,
      totalTokenCount: 165,
      cachedContentTokenCount: 20,
      thoughtsTokenCount: 15,
    })
  })

  it('extracts thoughtsTokenCount from candidatesTokensDetails modality THINKING or REASONING', () => {
    const chunk = {
      candidates: [{
        content: {
          parts: [
            { id: 'part_fallback_id', functionCall: { name: 'query_db', args: { sql: 'SELECT 1' } } },
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 40,
        totalTokenCount: 140,
        candidatesTokensDetails: [
          null,
          {},
          { modality: 'OTHER', tokenCount: 5 },
          { modality: 'THINKING', tokenCount: 22 },
        ],
      },
    }
    const parsed = parseGeminiStreamChunk(chunk)
    expect(parsed.usage?.thoughtsTokenCount).toBe(22)
    expect(parsed.toolCalls?.[0]?.id).toBe('part_fallback_id')

    const chunkReasoning = {
      candidates: [{ content: { parts: [{ text: 'done' }] } }],
      usageMetadata: {
        candidatesTokensDetails: [
          { modality: 'REASONING', tokenCount: 18 },
        ],
      },
    }
    const parsedReasoning = parseGeminiStreamChunk(chunkReasoning)
    expect(parsedReasoning.usage?.thoughtsTokenCount).toBe(18)
    expect(parsedReasoning.usage?.totalTokenCount).toBeUndefined()
  })

  it('handles object input directly without double JSON parsing', () => {
    const obj = {
      candidates: [{
        content: {
          parts: [{ text: 'Direct object' }],
        },
      }],
    }
    const parsed = parseGeminiStreamChunk(obj)
    expect(parsed.text).toBe('Direct object')
  })

  it('handles array payload chunks and ignores non-object items', () => {
    const chunk = [
      null,
      123,
      'string',
      {
        candidates: [
          null,
          'not-an-object',
          {
            content: {
              parts: [
                null,
                123,
                { text: 'Array element candidate' },
                { functionCall: { name: '' } },
                { functionCall: { id: 'call_no_name' } },
              ],
            },
          },
        ],
      },
    ]
    const parsed = parseGeminiStreamChunk(chunk)
    expect(parsed.text).toBe('Array element candidate')
  })

  it('throws LlmError with MALFORMED_RESPONSE on invalid JSON string', () => {
    expect(() => parseGeminiStreamChunk('{ invalid json ...')).toThrow(LlmError)
    try {
      parseGeminiStreamChunk('{ invalid json ...')
    } catch (err: unknown) {
      if (err instanceof LlmError) {
        expect(err.failure.code).toBe('MALFORMED_RESPONSE')
      }
    }
  })

  it('handles chunks with no candidates or invalid payloads gracefully', () => {
    const parsed1 = parseGeminiStreamChunk(JSON.stringify({ usageMetadata: { totalTokenCount: 10 } }))
    expect(parsed1.text).toBeUndefined()
    expect(parsed1.thought).toBeUndefined()
    expect(parsed1.toolCalls).toBeUndefined()
    expect(parsed1.usage?.totalTokenCount).toBe(10)

    const parsed2 = parseGeminiStreamChunk(null as unknown as Record<string, unknown>)
    expect(parsed2.text).toBeUndefined()
    expect(parsed2.thought).toBeUndefined()
    expect(parsed2.toolCalls).toBeUndefined()
  })
})

describe('Gemini Finish Reason & Usage Mapping', () => {
  it('maps stop finish reason correctly', () => {
    expect(mapGeminiFinishReason('STOP', true, false)).toEqual({ kind: 'stop' })
    expect(mapGeminiFinishReason('stop', true, false)).toEqual({ kind: 'stop' })
  })

  it('maps stop with no content to EMPTY_RESPONSE error', () => {
    const res = mapGeminiFinishReason('STOP', false, false)
    expect(res.kind).toBe('error')
    if (res.kind === 'error') {
      expect(res.failure.code).toBe(EMPTY_RESPONSE_CODE)
    }
  })

  it('maps stop with tool calls to tool-calls finish', () => {
    expect(mapGeminiFinishReason('STOP', true, true)).toEqual({ kind: 'tool-calls' })
    expect(mapGeminiFinishReason(undefined, true, true)).toEqual({ kind: 'tool-calls' })
  })

  it('maps MAX_TOKENS / length to max-tokens', () => {
    expect(mapGeminiFinishReason('MAX_TOKENS', true, false)).toEqual({ kind: 'max-tokens' })
    expect(mapGeminiFinishReason('LENGTH', true, false)).toEqual({ kind: 'max-tokens' })
  })

  it('maps TOOL_CALLS to tool-calls finish', () => {
    expect(mapGeminiFinishReason('TOOL_CALLS', true, false)).toEqual({ kind: 'tool-calls' })
  })

  it('maps safety and policy stops to typed error finishes', () => {
    const safety = mapGeminiFinishReason('SAFETY', true, false)
    expect(safety.kind).toBe('error')
    if (safety.kind === 'error') expect(safety.failure.code).toBe('SAFETY')

    const recitation = mapGeminiFinishReason('RECITATION', true, false)
    expect(recitation.kind).toBe('error')
    if (recitation.kind === 'error') expect(recitation.failure.code).toBe('RECITATION')

    const blocklist = mapGeminiFinishReason('BLOCKLIST', true, false)
    expect(blocklist.kind).toBe('error')
    if (blocklist.kind === 'error') expect(blocklist.failure.code).toBe('BLOCKLIST')

    const prohibited = mapGeminiFinishReason('PROHIBITED_CONTENT', true, false)
    expect(prohibited.kind).toBe('error')
    if (prohibited.kind === 'error') expect(prohibited.failure.code).toBe('PROHIBITED_CONTENT')

    const spii = mapGeminiFinishReason('SPII', true, false)
    expect(spii.kind).toBe('error')
    if (spii.kind === 'error') expect(spii.failure.code).toBe('SPII')

    const malformedCall = mapGeminiFinishReason('MALFORMED_FUNCTION_CALL', true, false)
    expect(malformedCall.kind).toBe('error')
    if (malformedCall.kind === 'error') expect(malformedCall.failure.code).toBe('MALFORMED_FUNCTION_CALL')

    const other = mapGeminiFinishReason('OTHER', true, false)
    expect(other.kind).toBe('error')
    if (other.kind === 'error') expect(other.failure.code).toBe('OTHER')

    const unknown = mapGeminiFinishReason('CUSTOM_POLICY', true, false)
    expect(unknown.kind).toBe('error')
    if (unknown.kind === 'error') expect(unknown.failure.code).toBe('CUSTOM_POLICY')
  })

  it('maps undefined finish reason properly for content vs empty', () => {
    expect(mapGeminiFinishReason(undefined, true, false)).toEqual({ kind: 'stop' })
    const emptyRes = mapGeminiFinishReason(undefined, false, false)
    expect(emptyRes.kind).toBe('error')
    if (emptyRes.kind === 'error') {
      expect(emptyRes.failure.code).toBe(EMPTY_RESPONSE_CODE)
    }
  })

  it('maps disjoint token usage correctly', () => {
    const usage = mapGeminiUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      totalTokenCount: 150,
      cachedContentTokenCount: 30,
      thoughtsTokenCount: 25,
    })
    expect(usage).toEqual({
      inputTokens: 70,
      outputTokens: 50,
      cacheReadTokens: 30,
      reasoningTokens: 25,
    })

    const simpleUsage = mapGeminiUsage({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
    })
    expect(simpleUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    })

    const noPromptUsage = mapGeminiUsage({
      candidatesTokenCount: 8,
      thoughtsTokenCount: 0,
    })
    expect(noPromptUsage).toEqual({
      inputTokens: 0,
      outputTokens: 8,
    })

    const cacheLargerUsage = mapGeminiUsage({
      promptTokenCount: 5,
      cachedContentTokenCount: 10,
    })
    expect(cacheLargerUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10,
    })
  })

  it('returns undefined usage when metadata is absent', () => {
    expect(mapGeminiUsage(undefined)).toBeUndefined()
  })
})

describe('Gemini Error Translation (translateGeminiError)', () => {
  const mockUserTier: UserTier = {
    id: 'AGY_PRO_TIER',
    name: 'Gemini Pro Subscriber',
    upgradeSubscriptionUri: 'https://one.google.com/explore-plan/custom-tier',
  }

  it('translates HTTP 402 with tier upgrade URL into QUOTA_EXHAUSTED', () => {
    const err = translateGeminiError(402, { error: { message: 'Payment required' } }, mockUserTier)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.failure.code).toBe('QUOTA_EXHAUSTED')
    expect(err.failure.status).toBe(402)
    expect(err.message).toContain('https://one.google.com/explore-plan/custom-tier')

    const errNoDetail = translateGeminiError(402, undefined, undefined)
    expect(errNoDetail.failure.code).toBe('QUOTA_EXHAUSTED')
    expect(errNoDetail.message).toContain(DEFAULT_UPGRADE_URI)
  })

  it('translates HTTP 426 with fallback upgrade URL when userTier has none', () => {
    const err = translateGeminiError(426, 'Upgrade Required', null)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.failure.code).toBe('QUOTA_EXHAUSTED')
    expect(err.failure.status).toBe(426)
    expect(err.message).toContain(DEFAULT_UPGRADE_URI)
  })

  it('translates HTTP 429 quota exhaustion to QUOTA_EXHAUSTED', () => {
    const err = translateGeminiError(429, { error: { message: 'Resource has been exhausted (e.g. check quota).' } }, mockUserTier)
    expect(err.failure.code).toBe('QUOTA_EXHAUSTED')
    expect(err.failure.status).toBe(429)
    expect(err.message).toContain('https://one.google.com/explore-plan/custom-tier')

    const err2 = translateGeminiError(429, 'quota_exceeded', null)
    expect(err2.failure.code).toBe('QUOTA_EXHAUSTED')
  })

  it('translates HTTP 429 rate limit to RATE_LIMIT', () => {
    const err = translateGeminiError(429, { error: { message: 'Rate limit exceeded. Please retry later.' } })
    expect(err.failure.code).toBe('RATE_LIMIT')
    expect(err.failure.status).toBe(429)

    const errBlank = translateGeminiError(429, '')
    expect(errBlank.failure.code).toBe('RATE_LIMIT')
  })

  it('translates HTTP 400 context overflow to CONTEXT_WINDOW_EXCEEDED', () => {
    const err = translateGeminiError(400, { error: { message: 'Request exceeds maximum context length of 1048576 tokens.' } })
    expect(err.failure.code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(err.failure.status).toBe(400)
  })

  it('translates generic HTTP 400 to INVALID_REQUEST', () => {
    const err = translateGeminiError(400, { error: { message: 'Invalid field in request payload.' } })
    expect(err.failure.code).toBe('INVALID_REQUEST')
    expect(err.failure.status).toBe(400)

    const errEmpty = translateGeminiError(400, '')
    expect(errEmpty.failure.code).toBe('INVALID_REQUEST')
  })

  it('translates HTTP 401 / 403 to AUTH', () => {
    const err401 = translateGeminiError(401, 'Unauthorized')
    expect(err401.failure.code).toBe('AUTH')
    expect(err401.failure.status).toBe(401)

    const err403 = translateGeminiError(403, 'Permission denied')
    expect(err403.failure.code).toBe('AUTH')
    expect(err403.failure.status).toBe(403)

    const err401Blank = translateGeminiError(401, '')
    expect(err401Blank.failure.code).toBe('AUTH')
  })

  it('translates HTTP 404 to NOT_FOUND', () => {
    const err = translateGeminiError(404, 'Model not found')
    expect(err.failure.code).toBe('NOT_FOUND')
    expect(err.failure.status).toBe(404)

    const errBlank = translateGeminiError(404, '')
    expect(errBlank.failure.code).toBe('NOT_FOUND')
  })

  it('translates HTTP 500..599 to SERVER', () => {
    const err500 = translateGeminiError(500, 'Internal server error')
    expect(err500.failure.code).toBe('SERVER')
    expect(err500.failure.status).toBe(500)

    const err503 = translateGeminiError(503, 'Service unavailable')
    expect(err503.failure.code).toBe('SERVER')
    expect(err503.failure.status).toBe(503)

    const err500Blank = translateGeminiError(500, '')
    expect(err500Blank.failure.code).toBe('SERVER')
  })

  it('translates other HTTP status codes', () => {
    const err418 = translateGeminiError(418, 'I am a teapot')
    expect(err418.failure.code).toBe('CLIENT_ERROR')
    expect(err418.failure.status).toBe(418)

    const err302 = translateGeminiError(302, '')
    expect(err302.failure.code).toBe('HTTP_ERROR')
    expect(err302.failure.status).toBe(302)

    const errInvalidStatus = translateGeminiError(0, 'Unknown failure')
    expect(errInvalidStatus.failure.status).toBeUndefined()
  })

  it('extracts error messages from error_description, error string, error object without message, and direct message', () => {
    const errDesc = translateGeminiError(400, { error_description: 'OAuth error description' })
    expect(errDesc.message).toBe('OAuth error description')

    const errStr = translateGeminiError(400, { error: 'Direct error value' })
    expect(errStr.message).toBe('Direct error value')

    const errObjNoMsg = translateGeminiError(400, { error: { code: 400 } })
    expect(errObjNoMsg.message).toBe('Google Gemini rejected the request as invalid.')

    const errDirectMsg = translateGeminiError(400, { message: 'Direct message field' })
    expect(errDirectMsg.message).toBe('Direct message field')

    const errNonStringMsg = translateGeminiError(400, { message: 12345 })
    expect(errNonStringMsg.message).toBe('Google Gemini rejected the request as invalid.')

    const errPrimitive = translateGeminiError(400, 12345)
    expect(errPrimitive.message).toBe('12345')

    const errBool = translateGeminiError(400, true)
    expect(errBool.message).toBe('true')

    const errNoBody401 = translateGeminiError(401)
    expect(errNoBody401.message).toBe('Google Gemini authentication failed or permission denied.')

    const errNoBody404 = translateGeminiError(404)
    expect(errNoBody404.message).toBe('Google Gemini resource or model not found.')

    const errNoBody500 = translateGeminiError(500)
    expect(errNoBody500.message).toBe('Google Gemini server error (HTTP 500).')

    const errNoBody418 = translateGeminiError(418)
    expect(errNoBody418.message).toBe('Google Gemini HTTP request failed with status 418.')
  })

  it('extracts retry delay when available in details', () => {
    const err = translateGeminiError(429, {
      error: {
        message: 'Resource exhausted',
        details: [
          null,
          'primitive',
          { '@type': 'other' },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '5s',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: 'invalid-number',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '-10s',
          },
        ],
      },
    })
    expect(err.failure.providerRetryAfterMs).toBe(5000)

    const errDescRetry = translateGeminiError(429, {
      error_description: 'Rate limit hit',
      error: {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '3s',
          },
        ],
      },
    })
    expect(errDescRetry.message).toBe('Rate limit hit')
    expect(errDescRetry.failure.providerRetryAfterMs).toBe(3000)

    const errStrRetry = translateGeminiError(429, {
      error: 'Rate limit text',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '2s',
        },
      ],
    })
    expect(errStrRetry.message).toBe('Rate limit text')
    expect(errStrRetry.failure.providerRetryAfterMs).toBe(2000)

    const err402Retry = translateGeminiError(402, {
      error: {
        message: 'Payment required',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '60s',
          },
        ],
      },
    })
    expect(err402Retry.failure.providerRetryAfterMs).toBe(60000)

    const err429QuotaRetry = translateGeminiError(429, {
      error: {
        message: 'Quota exceeded for project',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '15s',
          },
        ],
      },
    })
    expect(err429QuotaRetry.failure.providerRetryAfterMs).toBe(15000)

    const errEmptyObj = translateGeminiError(400, { other: 123 })
    expect(errEmptyObj.message).toBe('Google Gemini rejected the request as invalid.')
  })
})

describe('Gemini Response Streaming (streamGeminiResponse)', () => {
  it('streams text and thought chunks with block-start, deltas, and block-end', async () => {
    const sseLines = [
      'data: {"candidates":[{"content":{"parts":[{"thought":"Thinking step 1..."}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"thought":" Thinking step 2."}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" from Gemini!"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":6,"totalTokenCount":16}}\n\n',
    ]

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(new TextEncoder().encode(line))
        }
        controller.close()
      },
    })

    const chunks = []
    for await (const chunk of streamGeminiResponse({ stream })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Thinking step 1...' },
      { type: 'reasoning-delta', index: 0, text: ' Thinking step 2.' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello world' },
      { type: 'text-delta', index: 1, text: ' from Gemini!' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Thinking step 1... Thinking step 2.' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world from Gemini!' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 6 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('streams tool call invocations with object args and string args across multiple deltas', async () => {
    const sseLines = [
      ': comment line should be skipped\n',
      'event: message\n',
      'id: 1\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"calc","args":{"a":1}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"calc","args":"{\\"b\\":2}"}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model"},"finishReason":"STOP"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const chunks = []
    for await (const chunk of streamGeminiResponse({ stream: sseLines })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_0', name: 'calc', argumentsDelta: '{"a":1}' },
      { type: 'tool-call-delta', index: 0, id: 'call_0', name: 'calc', argumentsDelta: '{"b":2}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_0', name: 'calc', arguments: '{"a":1}{"b":2}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('handles explicit stream passed with response', async () => {
    const mockResp = new Response('ignored', { status: 200 })
    const customLines = ['data: {"candidates":[{"content":{"parts":[{"text":"Custom stream payload"}]},"finishReason":"STOP"}]}\n\n']

    const chunks = []
    for await (const chunk of streamGeminiResponse({ response: mockResp, stream: customLines })) {
      chunks.push(chunk)
    }

    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Custom stream payload')).toBe(true)
  })

  it('handles reader-only stream objects with getReader', async () => {
    let callCount = 0
    const mockReaderStream = {
      getReader() {
        return {
          async read() {
            callCount++
            if (callCount === 1) {
              return { done: false, value: new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Reader chunk"}]},"finishReason":"STOP"}]}\n\n') }
            }
            return { done: true, value: undefined }
          },
          releaseLock() {},
        }
      },
    }

    const chunks = []
    for await (const chunk of streamGeminiResponse({ stream: mockReaderStream as unknown as ReadableStream<Uint8Array> })) {
      chunks.push(chunk)
    }

    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Reader chunk')).toBe(true)
  })

  it('handles various line formatting like data: without space, raw json, and trailing buffer', async () => {
    const ssePayload = [
      'data:{"candidates":[{"content":{"parts":[{"text":"No space after data:"}]}}]}\n',
      '{"candidates":[{"content":{"parts":[{"text":"Raw object line"}]}}]}\n',
      '[{"candidates":[{"content":{"parts":[{"text":"Raw array line"}]}}]}]\n',
      'unsupported_field_prefix: ignored\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"Trailing buffer without newline"}]}}]}',
    ].join('')

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePayload))
        controller.close()
      },
    })

    const chunks = []
    for await (const chunk of streamGeminiResponse(stream)) {
      chunks.push(chunk)
    }

    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'No space after data:')).toBe(true)
    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Raw object line')).toBe(true)
    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Raw array line')).toBe(true)
    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Trailing buffer without newline')).toBe(true)
  })

  it('streams from an AsyncIterable of Uint8Array byte chunks', async () => {
    async function* makeByteStream() {
      yield new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Byte stream part 1"}]}}]}\n')
      yield new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":" part 2"}]},"finishReason":"STOP"}]}\n')
    }

    const chunks = []
    for await (const chunk of streamGeminiResponse(makeByteStream())) {
      chunks.push(chunk)
    }

    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Byte stream part 1')).toBe(true)
    expect(chunks.some(c => c.type === 'text-delta' && c.text === ' part 2')).toBe(true)
  })

  it('handles HTTP error responses by throwing translated LlmError', async () => {
    const mockResponse = new Response(JSON.stringify({ error: { message: 'Quota exceeded for project' } }), {
      status: 402,
      statusText: 'Payment Required',
    })

    await expect(async () => {
      for await (const _ of streamGeminiResponse({ response: mockResponse })) {
        // no-op
      }
    }).rejects.toThrow(LlmError)
  })

  it('handles HTTP error responses when reading response text throws', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      statusText: 'Internal Error',
      text: vi.fn().mockRejectedValue(new Error('Stream read failed')),
    } as unknown as Response

    await expect(async () => {
      for await (const _ of streamGeminiResponse(mockResponse)) {
        // no-op
      }
    }).rejects.toThrow(LlmError)
  })

  it('handles AbortSignal cancellation before stream start and mid-stream', async () => {
    const abortController = new AbortController()
    abortController.abort()

    const chunksBefore = []
    for await (const chunk of streamGeminiResponse({ stream: new ReadableStream(), signal: abortController.signal })) {
      chunksBefore.push(chunk)
    }

    expect(chunksBefore).toEqual([
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Gemini stream aborted', code: 'ABORTED' } } },
    ])

    const midAbortController = new AbortController()
    async function* abortingStream() {
      yield 'data: {"candidates":[{"content":{"parts":[{"text":"Chunk 1"}]}}]}\n\n'
      midAbortController.abort()
      yield 'data: {"candidates":[{"content":{"parts":[{"text":"Chunk 2"}]}}]}\n\n'
    }

    const chunksMid = []
    for await (const chunk of streamGeminiResponse({ stream: abortingStream(), signal: midAbortController.signal })) {
      chunksMid.push(chunk)
    }

    expect(chunksMid.some(c => c.type === 'block-start')).toBe(true)
    expect(chunksMid[chunksMid.length - 1]).toEqual({
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'Gemini stream aborted', code: 'ABORTED' } },
    })
  })

  it('throws EMPTY_RESPONSE if stream is missing or empty or options is primitive', async () => {
    await expect(async () => {
      for await (const _ of streamGeminiResponse({})) {
        // no-op
      }
    }).rejects.toThrow(LlmError)

    await expect(async () => {
      for await (const _ of streamGeminiResponse(null)) {
        // no-op
      }
    }).rejects.toThrow(LlmError)

    await expect(async () => {
      for await (const _ of streamGeminiResponse(undefined)) {
        // no-op
      }
    }).rejects.toThrow(LlmError)
  })

  it('handles direct Response object passed as positional argument', async () => {
    const sseLine = 'data: {"candidates":[{"content":{"parts":[{"text":"Position arg"}]},"finishReason":"STOP"}]}\n\n'
    const mockResponse = new Response(sseLine, { status: 200 })

    const chunks = []
    for await (const chunk of streamGeminiResponse(mockResponse)) {
      chunks.push(chunk)
    }

    expect(chunks.some(c => c.type === 'text-delta' && c.text === 'Position arg')).toBe(true)
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
