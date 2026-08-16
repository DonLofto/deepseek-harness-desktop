/**
 * Error translation and classification for Google Gemini and Cloud Code API errors.
 * @module @deepseek-ai/dsh-llm-gemini/error
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { UserTier } from './types.ts'

/** Default subscription exploration URI for Gemini upgrades. */
export const DEFAULT_UPGRADE_URI = 'https://one.google.com/explore-plan'

/**
 * Checks if an error string matches Google/Gemini quota exhaustion patterns.
 *
 * @param message - Raw error message string to evaluate.
 * @returns True if the message indicates quota or billing exhaustion.
 */
function isGoogleQuotaExhausted(message: string): boolean {
  if (isQuotaExceededError(message)) return true
  const lower = message.toLowerCase()
  return (
    lower.includes('quota')
    || lower.includes('resource has been exhausted')
    || lower.includes('resource_exhausted')
    || lower.includes('insufficient quota')
    || lower.includes('billing')
    || lower.includes('upgrade')
  )
}

/**
 * Extracts error details from a raw error response payload.
 *
 * @param errorBody - Response body string or deserialized JSON object.
 * @returns Object with extracted message and optional retry-after in milliseconds.
 */
function extractErrorDetails(errorBody: unknown): { message: string; retryDelayMs?: number } {
  if (typeof errorBody === 'string') {
    try {
      const parsed = JSON.parse(errorBody) as unknown
      return extractErrorDetails(parsed)
    } catch {
      return { message: errorBody.trim() }
    }
  }

  if (typeof errorBody === 'object' && errorBody !== null) {
    const errObj = errorBody as Record<string, unknown>
    let retryDelayMs: number | undefined

    const errorProp = typeof errObj.error === 'object' && errObj.error !== null
      ? (errObj.error as Record<string, unknown>)
      : undefined
    const details = Array.isArray(errorProp?.details) ? errorProp.details : (Array.isArray(errObj.details) ? errObj.details : undefined)
    if (Array.isArray(details)) {
      for (const item of details) {
        if (typeof item === 'object' && item !== null) {
          const detail = item as Record<string, unknown>
          if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
            const delayStr = typeof detail.retryDelay === 'string' ? detail.retryDelay : ''
            const seconds = Number.parseFloat(delayStr.replace(/s$/, ''))
            if (!Number.isNaN(seconds) && seconds > 0) {
              retryDelayMs = Math.round(seconds * 1000)
            }
          }
        }
      }
    }

    if (typeof errObj.error_description === 'string') {
      return {
        message: errObj.error_description.trim(),
        ...typeof retryDelayMs === 'number' ? { retryDelayMs } : {},
      }
    }

    if (typeof errObj.error === 'string') {
      return {
        message: errObj.error.trim(),
        ...typeof retryDelayMs === 'number' ? { retryDelayMs } : {},
      }
    }

    const candidate = typeof errObj.error === 'object' && errObj.error !== null
      ? (errObj.error as Record<string, unknown>)
      : errObj

    const candidateMsg = typeof candidate.message === 'string' ? candidate.message.trim() : ''
    return {
      message: candidateMsg,
      ...typeof retryDelayMs === 'number' ? { retryDelayMs } : {},
    }
  }

  if (typeof errorBody === 'number' || typeof errorBody === 'boolean') {
    return { message: String(errorBody).trim() }
  }

  return { message: '' }
}

/**
 * Translates Google Gemini HTTP errors and quota responses into typed {@link LlmError}.
 *
 * @param status - HTTP response status code.
 * @param errorBody - Raw response text or parsed JSON body.
 * @param userTier - Optional user tier containing custom upgrade subscription URIs.
 * @returns Typed {@link LlmError} with standardized code, status, and upgrade instructions.
 */
export function translateGeminiError(
  status: number,
  errorBody?: unknown,
  userTier?: UserTier | null,
): LlmError {
  const { message: rawMessage, retryDelayMs } = extractErrorDetails(errorBody)
  const upgradeUri = userTier?.upgradeSubscriptionUri ?? DEFAULT_UPGRADE_URI

  if (status === 402 || status === 426) {
    const defaultMsg = status === 402
      ? `Google Gemini subscription required: quota exhausted. Upgrade your subscription plan at ${upgradeUri}`
      : `Google Gemini upgrade required. Upgrade your subscription plan at ${upgradeUri}`
    const finalMsg = rawMessage.length > 0 ? `${rawMessage}. Upgrade plan at ${upgradeUri}` : defaultMsg

    return new LlmError(finalMsg, 'QUOTA_EXHAUSTED', {
      status,
      ...typeof retryDelayMs === 'number' ? { providerRetryAfterMs: retryDelayMs } : {},
    })
  }

  if (status === 429) {
    if (isGoogleQuotaExhausted(rawMessage)) {
      const msg = `${rawMessage}. Upgrade subscription plan at ${upgradeUri}`
      return new LlmError(msg, 'QUOTA_EXHAUSTED', {
        status,
        ...typeof retryDelayMs === 'number' ? { providerRetryAfterMs: retryDelayMs } : {},
      })
    }
    return new LlmError(
      rawMessage.length > 0 ? rawMessage : 'Google Gemini rate limit exceeded. Please retry later.',
      'RATE_LIMIT',
      {
        status,
        ...typeof retryDelayMs === 'number' ? { providerRetryAfterMs: retryDelayMs } : {},
      },
    )
  }

  if (status === 400) {
    if (isContextWindowExceededError(rawMessage) || rawMessage.toLowerCase().includes('maximum context length')) {
      return new LlmError(
        rawMessage,
        CONTEXT_WINDOW_EXCEEDED_CODE,
        { status },
      )
    }
    return new LlmError(
      rawMessage.length > 0 ? rawMessage : 'Google Gemini rejected the request as invalid.',
      'INVALID_REQUEST',
      { status },
    )
  }

  if (status === 401 || status === 403) {
    return new LlmError(
      rawMessage.length > 0 ? rawMessage : 'Google Gemini authentication failed or permission denied.',
      'AUTH',
      { status },
    )
  }

  if (status === 404) {
    return new LlmError(
      rawMessage.length > 0 ? rawMessage : 'Google Gemini resource or model not found.',
      'NOT_FOUND',
      { status },
    )
  }

  if (status >= 500 && status <= 599) {
    return new LlmError(
      rawMessage.length > 0 ? rawMessage : `Google Gemini server error (HTTP ${status}).`,
      'SERVER',
      { status },
    )
  }

  const code = status >= 400 && status < 500 ? 'CLIENT_ERROR' : 'HTTP_ERROR'
  return new LlmError(
    rawMessage.length > 0 ? rawMessage : `Google Gemini HTTP request failed with status ${status}.`,
    code,
    { ...status > 0 ? { status } : {} },
  )
}
