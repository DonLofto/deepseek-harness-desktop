/**
 * Google Gemini SSE stream parser, chunk translator, and finish reason mapping.
 * @module @deepseek-ai/dsh-llm-gemini/stream
 */

import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { translateGeminiError } from './error.ts'
import type { UserTier } from './types.ts'

/**
 * One tool/function call extracted from a Gemini part.
 */
export interface ParsedGeminiToolCall {
  /** Optional identifier for the tool call. */
  id?: string
  /** Name of the function/tool to call. */
  name: string
  /** Arguments object or raw JSON string. */
  args: Record<string, unknown> | string
}

/**
 * Result of parsing one Gemini stream chunk or candidate.
 */
export interface ParsedGeminiChunk {
  /** Extracted plain text content, if any. */
  text?: string
  /** Extracted thought/reasoning text, if any. */
  thought?: string
  /** Extracted function/tool calls, if any. */
  toolCalls?: ParsedGeminiToolCall[]
  /** Candidate finish reason (e.g. 'STOP', 'MAX_TOKENS', 'SAFETY'), if present. */
  finishReason?: string
  /** Usage metadata from the chunk, if present. */
  usage?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
}

/**
 * Options for streaming a Gemini response.
 */
export interface StreamGeminiOptions {
  /** Fetch response object to consume. */
  response?: Response | undefined
  /** Readable stream of byte chunks or AsyncIterable of strings/bytes. */
  stream?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string> | undefined
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal | undefined
  /** Optional user subscription tier for quota error handling. */
  userTier?: UserTier | null | undefined
}

/** Input stream types accepted by {@link streamGeminiResponse}. */
export type StreamGeminiInput =
  | StreamGeminiOptions
  | Response
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>
  | Iterable<Uint8Array | string>
  | null
  | undefined

/**
 * Parses a single Gemini SSE JSON data payload into structured text, thoughts, tool calls, and usage.
 *
 * @param jsonText - Raw JSON string or deserialized candidate object.
 * @returns Parsed Gemini chunk with extracted text, reasoning thoughts, and function calls.
 */
export function parseGeminiStreamChunk(jsonText: string | Record<string, unknown> | unknown[]): ParsedGeminiChunk {
  let payload: unknown
  if (typeof jsonText === 'string') {
    try {
      payload = JSON.parse(jsonText)
    } catch {
      throw new LlmError(
        `malformed Gemini stream chunk: ${jsonText.slice(0, 120)}`,
        'MALFORMED_RESPONSE',
      )
    }
  } else {
    payload = jsonText
  }

  const chunks: Array<Record<string, unknown>> = Array.isArray(payload)
    ? (payload.filter(p => typeof p === 'object' && p !== null) as Array<Record<string, unknown>>)
    : (typeof payload === 'object' && payload !== null ? [payload as Record<string, unknown>] : [])

  let combinedText: string | undefined
  let combinedThought: string | undefined
  const toolCalls: ParsedGeminiToolCall[] = []
  let finishReason: string | undefined
  let usage: ParsedGeminiChunk['usage']

  for (const item of chunks) {
    const candidates: Array<Record<string, unknown>> = Array.isArray(item.candidates)
      ? (item.candidates.filter(c => typeof c === 'object' && c !== null) as Array<Record<string, unknown>>)
      : []
    for (const cand of candidates) {
      if (typeof cand.finishReason === 'string') {
        finishReason = cand.finishReason
      }

      const content = cand.content as Record<string, unknown> | undefined
      const parts = Array.isArray(content?.parts) ? content.parts : []

      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue

        const partObj = part as Record<string, unknown>
        if (typeof partObj.thought === 'string' && partObj.thought.length > 0) {
          combinedThought = (combinedThought ?? '') + partObj.thought
        } else if (partObj.thought === true && typeof partObj.text === 'string' && partObj.text.length > 0) {
          combinedThought = (combinedThought ?? '') + partObj.text
        } else if (typeof partObj.text === 'string' && partObj.text.length > 0) {
          combinedText = (combinedText ?? '') + partObj.text
        }

        if (typeof partObj.functionCall === 'object' && partObj.functionCall !== null) {
          const fc = partObj.functionCall as Record<string, unknown>
          const name = typeof fc.name === 'string' ? fc.name : ''
          const args = (typeof fc.args === 'object' && fc.args !== null ? fc.args : (fc.args ?? {})) as Record<string, unknown> | string
          const id = typeof fc.id === 'string' ? fc.id : (typeof partObj.id === 'string' ? partObj.id : undefined)
          if (name.length > 0) {
            toolCalls.push({
              ...id !== undefined ? { id } : {},
              name,
              args,
            })
          }
        }
      }
    }

    if (typeof item.usageMetadata === 'object' && item.usageMetadata !== null) {
      const um = item.usageMetadata as Record<string, unknown>
      let thoughtsTokenCount: number | undefined
      if (typeof um.thoughtsTokenCount === 'number') {
        thoughtsTokenCount = um.thoughtsTokenCount
      } else if (Array.isArray(um.candidatesTokensDetails)) {
        for (const detail of um.candidatesTokensDetails) {
          if (typeof detail === 'object' && detail !== null) {
            const d = detail as Record<string, unknown>
            if ((d.modality === 'THINKING' || d.modality === 'REASONING') && typeof d.tokenCount === 'number') {
              thoughtsTokenCount = d.tokenCount
            }
          }
        }
      }

      usage = {
        ...typeof um.promptTokenCount === 'number' ? { promptTokenCount: um.promptTokenCount } : {},
        ...typeof um.candidatesTokenCount === 'number' ? { candidatesTokenCount: um.candidatesTokenCount } : {},
        ...typeof um.totalTokenCount === 'number' ? { totalTokenCount: um.totalTokenCount } : {},
        ...typeof um.cachedContentTokenCount === 'number' ? { cachedContentTokenCount: um.cachedContentTokenCount } : {},
        ...thoughtsTokenCount !== undefined ? { thoughtsTokenCount } : {},
      }
    }
  }

  return {
    ...combinedText !== undefined ? { text: combinedText } : {},
    ...combinedThought !== undefined ? { thought: combinedThought } : {},
    ...toolCalls.length > 0 ? { toolCalls } : {},
    ...finishReason !== undefined ? { finishReason } : {},
    ...usage !== undefined ? { usage } : {},
  }
}

/**
 * Maps a Gemini wire finishReason string into the canonical {@link FinishReason}.
 *
 * @param reason - Wire finishReason string (e.g. 'STOP', 'MAX_TOKENS', 'SAFETY').
 * @param hasContent - Whether any content blocks (text, reasoning, or tool calls) were assembled.
 * @param hasToolCalls - Whether any tool-call blocks were emitted during generation.
 * @returns Canonical {@link FinishReason} representation.
 */
export function mapGeminiFinishReason(
  reason?: string,
  hasContent = false,
  hasToolCalls = false,
): FinishReason {
  const normalized = reason?.toUpperCase()

  if (normalized === 'STOP') {
    if (hasToolCalls) return { kind: 'tool-calls' }
    if (!hasContent) {
      return {
        kind: 'error',
        failure: {
          message: 'model returned a completed response with no content',
          code: EMPTY_RESPONSE_CODE,
        },
      }
    }
    return { kind: 'stop' }
  }

  if (normalized === 'MAX_TOKENS' || normalized === 'LENGTH') {
    return { kind: 'max-tokens' }
  }

  if (normalized === 'TOOL_CALLS') {
    return { kind: 'tool-calls' }
  }

  if (normalized === 'SAFETY') {
    return {
      kind: 'error',
      failure: { message: 'model stopped: generation blocked by safety filters', code: 'SAFETY' },
    }
  }

  if (normalized === 'RECITATION') {
    return {
      kind: 'error',
      failure: { message: 'model stopped: recitation policy violation', code: 'RECITATION' },
    }
  }

  if (normalized === 'BLOCKLIST') {
    return {
      kind: 'error',
      failure: { message: 'model stopped: term blocklist match', code: 'BLOCKLIST' },
    }
  }

  if (normalized === 'PROHIBITED_CONTENT') {
    return {
      kind: 'error',
      failure: { message: 'model stopped: prohibited content', code: 'PROHIBITED_CONTENT' },
    }
  }

  if (normalized === 'SPII') {
    return {
      kind: 'error',
      failure: { message: 'model stopped: sensitive personally identifiable information detected', code: 'SPII' },
    }
  }

  if (normalized === 'MALFORMED_FUNCTION_CALL') {
    return {
      kind: 'error',
      failure: { message: 'model stopped: malformed function call', code: 'MALFORMED_FUNCTION_CALL' },
    }
  }

  if (normalized === 'OTHER') {
    return {
      kind: 'error',
      failure: { message: 'model stopped: reason other', code: 'OTHER' },
    }
  }

  if (typeof reason === 'string' && reason.length > 0) {
    return {
      kind: 'error',
      failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
    }
  }

  if (hasToolCalls) return { kind: 'tool-calls' }
  if (!hasContent) {
    return {
      kind: 'error',
      failure: {
        message: 'model returned a completed response with no content',
        code: EMPTY_RESPONSE_CODE,
      },
    }
  }

  return { kind: 'stop' }
}

/**
 * Maps Gemini usageMetadata to disjoint {@link TokenUsage}.
 *
 * @param usage - Usage metadata extracted from Gemini chunk.
 * @returns Disjoint token accounting counts or undefined if missing.
 */
export function mapGeminiUsage(usage: ParsedGeminiChunk['usage']): TokenUsage | undefined {
  if (!usage) return undefined
  const cacheRead = usage.cachedContentTokenCount ?? 0
  const promptTokens = usage.promptTokenCount ?? 0
  const inputTokens = Math.max(0, promptTokens - cacheRead)
  const outputTokens = usage.candidatesTokenCount ?? 0
  const reasoning = usage.thoughtsTokenCount

  return {
    inputTokens,
    outputTokens,
    ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...typeof reasoning === 'number' && reasoning > 0 ? { reasoningTokens: reasoning } : {},
  }
}

/** One open content block under active assembly. */
type OpenBlock =
  | { index: number; kind: 'text'; text: string }
  | { index: number; kind: 'reasoning'; text: string }
  | { index: number; kind: 'tool-call'; text: string; callId: string; name: string }

/** Closes an open block into an immutable ContentBlock. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: CallId(block.callId),
        name: block.name,
        arguments: block.text,
      }
  }
}

/**
 * Iterates line-by-line over a ReadableStream, AsyncIterable, or Iterable of byte buffers or strings.
 *
 * @param stream - Source byte stream or string iterable.
 * @param signal - Optional cancellation signal.
 * @returns Async generator yielding complete lines.
 */
async function* iterateStreamLines(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  const streamObj = stream as unknown as Record<PropertyKey, unknown>
  const iterable: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string> =
    typeof streamObj[Symbol.asyncIterator] === 'function'
    || typeof streamObj[Symbol.iterator] === 'function'
      ? (stream as AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>)
      : {
        async *[Symbol.asyncIterator]() {
          const reader = (stream as ReadableStream<Uint8Array>).getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              yield value
            }
          } finally {
            reader.releaseLock()
          }
        },
      }

  for await (const chunk of iterable) {
    if (signal?.aborted) return
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    buffer += text
    const lastIndex = buffer.lastIndexOf('\n')
    if (lastIndex !== -1) {
      const chunkLines = buffer.slice(0, lastIndex).split(/\r?\n/)
      buffer = buffer.slice(lastIndex + 1)
      for (const line of chunkLines) {
        yield line
      }
    }
  }

  buffer += decoder.decode()
  if (buffer.trim().length > 0) {
    for (const line of buffer.split(/\r?\n/)) {
      yield line
    }
  }
}

/**
 * Consumes Gemini SSE response stream, parses line-by-line, and yields canonical {@link StreamChunk}s.
 *
 * @param options - Response, ReadableStream, AsyncIterable, or {@link StreamGeminiOptions} configuration.
 * @returns Async generator yielding stream chunks ending in block-end, usage, and finish.
 */
export async function* streamGeminiResponse(
  options?: StreamGeminiInput,
): AsyncGenerator<StreamChunk> {
  let response: Response | undefined
  let stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string> | undefined
  let signal: AbortSignal | undefined
  let userTier: UserTier | null | undefined

  if (options && typeof options === 'object') {
    if ('ok' in options && typeof options.ok === 'boolean') {
      response = options
    } else if (
      'response' in options
      || 'stream' in options
      || 'signal' in options
      || 'userTier' in options
      || (!('getReader' in options) && !(Symbol.asyncIterator in options) && !(Symbol.iterator in options))
    ) {
      const opt = options as StreamGeminiOptions
      response = opt.response
      stream = opt.stream
      signal = opt.signal
      userTier = opt.userTier
    } else {
      stream = options
    }
  }

  if (response) {
    if (!response.ok) {
      let errorBody: unknown
      try {
        errorBody = await response.text()
      } catch {
        errorBody = response.statusText
      }
      throw translateGeminiError(response.status, errorBody, userTier)
    }
    if (!stream && response.body) {
      stream = response.body as ReadableStream<Uint8Array>
    }
  }

  if (signal?.aborted) {
    yield {
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: { message: 'Gemini stream aborted', code: 'ABORTED' },
      },
    }
    return
  }

  if (!stream) {
    throw new LlmError('Response body stream is empty', EMPTY_RESPONSE_CODE)
  }

  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<string, { index: number; kind: 'tool-call'; text: string; callId: string; name: string }>()
  const order: OpenBlock[] = []
  let pendingFinishReason: string | undefined
  let pendingUsage: ParsedGeminiChunk['usage']

  for await (const rawLine of iterateStreamLines(stream, signal)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) {
      continue
    }

    let payloadText: string
    if (line.startsWith('data: ')) {
      payloadText = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      payloadText = line.slice(5).trim()
    } else if (line.startsWith('{') || line.startsWith('[')) {
      payloadText = line
    } else {
      continue
    }

    if (payloadText === '[DONE]') {
      break
    }

    const parsed = parseGeminiStreamChunk(payloadText)

    if (typeof parsed.thought === 'string' && parsed.thought.length > 0) {
      if (!reasoningBlock) {
        reasoningBlock = { index: nextIndex++, kind: 'reasoning', text: '' }
        order.push(reasoningBlock)
        yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
      }
      reasoningBlock.text += parsed.thought
      yield { type: 'reasoning-delta', index: reasoningBlock.index, text: parsed.thought }
    }

    if (typeof parsed.text === 'string' && parsed.text.length > 0) {
      if (!textBlock) {
        textBlock = { index: nextIndex++, kind: 'text', text: '' }
        order.push(textBlock)
        yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
      }
      textBlock.text += parsed.text
      yield { type: 'text-delta', index: textBlock.index, text: parsed.text }
    }

    for (const call of parsed.toolCalls ?? []) {
      const callKey = call.id ?? call.name
      let toolBlock = toolBlocks.get(callKey)
      const argsDelta = typeof call.args === 'string' ? call.args : JSON.stringify(call.args)

      if (!toolBlock) {
        const callId = call.id ?? `call_${nextIndex}`
        toolBlock = {
          index: nextIndex++,
          kind: 'tool-call',
          text: argsDelta,
          callId,
          name: call.name,
        }
        toolBlocks.set(callKey, toolBlock)
        order.push(toolBlock)
        yield { type: 'block-start', index: toolBlock.index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: toolBlock.index,
          id: CallId(callId),
          name: call.name,
          argumentsDelta: argsDelta,
        }
      } else {
        toolBlock.text += argsDelta
        yield {
          type: 'tool-call-delta',
          index: toolBlock.index,
          id: CallId(toolBlock.callId),
          name: toolBlock.name,
          argumentsDelta: argsDelta,
        }
      }
    }

    if (parsed.finishReason) {
      pendingFinishReason = parsed.finishReason
    }

    if (parsed.usage) {
      pendingUsage = parsed.usage
    }
  }

  for (const block of order) {
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }

  if (pendingUsage) {
    const usage = mapGeminiUsage(pendingUsage)
    yield { type: 'usage', usage: usage as TokenUsage }
  }

  if (signal?.aborted) {
    yield {
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: { message: 'Gemini stream aborted', code: 'ABORTED' },
      },
    }
    return
  }

  const finishReason = mapGeminiFinishReason(
    pendingFinishReason,
    order.length > 0,
    toolBlocks.size > 0,
  )

  yield { type: 'finish', reason: finishReason }
}
