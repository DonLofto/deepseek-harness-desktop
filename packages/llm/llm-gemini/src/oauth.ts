/**
 * Google OAuth 2.0 Device Code authorization grant and token lifecycle routines.
 * @module @deepseek-ai/dsh-llm-gemini/oauth
 */

/** Canonical Google OAuth 2.0 Device Authorization endpoint. */
export const DEFAULT_DEVICE_AUTH_ENDPOINT = 'https://oauth2.googleapis.com/device/code'

/** Canonical Google OAuth 2.0 Token endpoint. */
export const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Canonical Antigravity client ID for Google Cloud & Generative Language OAuth. */
export const DEFAULT_CLIENT_ID = '681284795324-4fchdh4hugndu4ffq1ldbmoc83bg4479.apps.googleusercontent.com'

/** Default Google OAuth scopes required for Cloud Code PA and Gemini API. */
export const DEFAULT_GOOGLE_OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
] as const

/**
 * Options for initiating the Google OAuth 2.0 Device Code authorization flow.
 */
export interface InitiateDeviceFlowOptions {
  /** OAuth 2.0 Client ID. Defaults to {@link DEFAULT_CLIENT_ID}. */
  clientId?: string | undefined
  /** OAuth 2.0 Client Secret if applicable. */
  clientSecret?: string | undefined
  /** OAuth 2.0 Scopes to request. Defaults to {@link DEFAULT_GOOGLE_OAUTH_SCOPES}. */
  scopes?: readonly string[] | undefined
  /** Custom device authorization endpoint URL. Defaults to {@link DEFAULT_DEVICE_AUTH_ENDPOINT}. */
  endpoint?: string | undefined
  /** Optional AbortSignal for cancelling the request. */
  signal?: AbortSignal | undefined
}

/**
 * Response payload returned from the Google OAuth 2.0 Device Code authorization endpoint.
 */
export interface DeviceCodeResponse {
  /** Device verification code used when polling for tokens. */
  device_code: string
  /** User verification code displayed to the end user. */
  user_code: string
  /** Verification URL where the user enters the code in their browser. */
  verification_url: string
  /** Alternative alias for verification URL defined in RFC 8628. */
  verification_uri?: string | undefined
  /** Lifetime of device_code and user_code in seconds. */
  expires_in: number
  /** Minimum polling interval in seconds. */
  interval: number
}

/**
 * Options for polling the Google OAuth 2.0 token endpoint during device flow.
 */
export interface PollDeviceTokenOptions {
  /** OAuth 2.0 Client ID. Defaults to {@link DEFAULT_CLIENT_ID}. */
  clientId?: string | undefined
  /** OAuth 2.0 Client Secret if applicable. */
  clientSecret?: string | undefined
  /** Device verification code received from {@link initiateGoogleDeviceFlow}. */
  deviceCode: string
  /** Initial polling interval in seconds. Defaults to 5. */
  interval?: number | undefined
  /** Expiration timeout in seconds. Defaults to 1800 (30 mins). */
  expiresIn?: number | undefined
  /** Custom token endpoint URL. Defaults to {@link DEFAULT_TOKEN_ENDPOINT}. */
  endpoint?: string | undefined
  /** Optional AbortSignal for cancelling polling. */
  signal?: AbortSignal | undefined
}

/**
 * Successful token response from Google OAuth 2.0 token endpoint.
 */
export interface GoogleTokenResponse {
  /** Access token used for bearer authentication in API calls. */
  access_token: string
  /** Access token validity lifetime in seconds. */
  expires_in: number
  /** Epoch timestamp in milliseconds when the access token expires. */
  expires_at: number
  /** Refresh token for obtaining new access tokens. */
  refresh_token?: string | undefined
  /** Granted OAuth scopes. */
  scope?: string | undefined
  /** Token type identifier, usually 'Bearer'. */
  token_type?: string | undefined
  /** OpenID Connect ID token containing user identity claims. */
  id_token?: string | undefined
}

/**
 * Options for refreshing an expired Google OAuth access token.
 */
export interface RefreshTokenOptions {
  /** OAuth 2.0 Client ID. Defaults to {@link DEFAULT_CLIENT_ID}. */
  clientId?: string | undefined
  /** OAuth 2.0 Client Secret if applicable. */
  clientSecret?: string | undefined
  /** Refresh token previously granted by Google OAuth. */
  refreshToken: string
  /** Custom token endpoint URL. Defaults to {@link DEFAULT_TOKEN_ENDPOINT}. */
  endpoint?: string | undefined
  /** Optional AbortSignal for cancelling the request. */
  signal?: AbortSignal | undefined
}

/**
 * Resolves an Error instance from an optional abort signal reason.
 * @param reason - Abort reason value.
 * @returns An Error instance.
 */
function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (typeof reason === 'string' && reason.length > 0) return new Error(reason)
  return new Error('Operation aborted')
}

/**
 * Asynchronously pauses execution for a specified duration, cancellable via AbortSignal.
 * @param ms - Milliseconds to sleep.
 * @param signal - Optional AbortSignal to cancel waiting.
 * @returns Promise that resolves after `ms` or rejects if aborted.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw toAbortError(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(toAbortError(signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Initiates the Google OAuth 2.0 Device Authorization Grant flow.
 *
 * Calls the Google device code endpoint and returns user code, verification URL,
 * and polling parameters according to RFC 8628.
 *
 * @param options - Configuration options for initiating device code authorization.
 * @returns Device code and user verification instructions.
 */
export async function initiateGoogleDeviceFlow(
  options: InitiateDeviceFlowOptions = {},
): Promise<DeviceCodeResponse> {
  const endpoint = options.endpoint ?? DEFAULT_DEVICE_AUTH_ENDPOINT
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID
  const scopes = options.scopes ?? DEFAULT_GOOGLE_OAUTH_SCOPES

  const body = new URLSearchParams({
    client_id: clientId,
    scope: scopes.join(' '),
  })
  if (options.clientSecret !== undefined) {
    body.set('client_secret', options.clientSecret)
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    ...options.signal !== undefined ? { signal: options.signal } : {},
  })

  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    payload = {}
  }

  if (!response.ok) {
    const errorDetail = (payload.error_description as string | undefined)
      ?? (payload.error as string | undefined)
      ?? response.statusText
    throw new Error(`Google OAuth device flow initiation failed (${response.status}): ${errorDetail}`)
  }

  const deviceCode = payload.device_code as string | undefined
  const userCode = payload.user_code as string | undefined
  const verificationUrl = (payload.verification_url as string | undefined)
    ?? (payload.verification_uri as string | undefined)
  const verificationUri = (payload.verification_uri as string | undefined)
    ?? (payload.verification_url as string | undefined)

  if (!deviceCode || !userCode) {
    throw new Error('Google OAuth device flow response missing device_code or user_code')
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_url: verificationUrl ?? '',
    ...verificationUri !== undefined ? { verification_uri: verificationUri } : {},
    expires_in: typeof payload.expires_in === 'number' ? payload.expires_in : 1800,
    interval: typeof payload.interval === 'number' ? payload.interval : 5,
  }
}

/**
 * Polls the Google OAuth 2.0 token endpoint until the user authorizes the device code.
 *
 * Implements exponential backoff on `slow_down`, retries gracefully on `authorization_pending`,
 * and respects caller abort signals and token expiration deadlines.
 *
 * @param options - Polling options including device code and polling interval.
 * @returns Granted Google OAuth access, refresh, and ID tokens.
 */
export async function pollGoogleDeviceToken(
  options: PollDeviceTokenOptions,
): Promise<GoogleTokenResponse> {
  let interval = Math.max(options.interval ?? 5, 1)
  const expiresIn = options.expiresIn ?? 1800
  const deadline = Date.now() + expiresIn * 1000
  const endpoint = options.endpoint ?? DEFAULT_TOKEN_ENDPOINT
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw toAbortError(options.signal.reason)
    }

    const body = new URLSearchParams({
      client_id: clientId,
      device_code: options.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (options.clientSecret !== undefined) {
      body.set('client_secret', options.clientSecret)
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      ...options.signal !== undefined ? { signal: options.signal } : {},
    })

    let payload: Record<string, unknown>
    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      payload = {}
    }

    if (response.ok && typeof payload.access_token === 'string') {
      const expiresInSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600
      return {
        access_token: payload.access_token,
        expires_in: expiresInSeconds,
        expires_at: Date.now() + expiresInSeconds * 1000,
        ...typeof payload.refresh_token === 'string' ? { refresh_token: payload.refresh_token } : {},
        ...typeof payload.scope === 'string' ? { scope: payload.scope } : {},
        ...typeof payload.token_type === 'string' ? { token_type: payload.token_type } : { token_type: 'Bearer' },
        ...typeof payload.id_token === 'string' ? { id_token: payload.id_token } : {},
      }
    }

    const errorCode = payload.error as string | undefined
    if (errorCode === 'authorization_pending') {
      await sleep(interval * 1000, options.signal)
      continue
    } else if (errorCode === 'slow_down') {
      interval += 5
      await sleep(interval * 1000, options.signal)
      continue
    } else if (errorCode === 'expired_token') {
      throw new Error('Google OAuth device authorization expired (expired_token)')
    } else if (errorCode === 'access_denied') {
      throw new Error('Google OAuth device authorization was denied by the user (access_denied)')
    } else {
      const errorMsg = (payload.error_description as string | undefined)
        ?? errorCode
        ?? `HTTP ${response.status}`
      throw new Error(`Google OAuth device token polling failed: ${errorMsg}`)
    }
  }

  throw new Error('Google OAuth device authorization timed out (expired_token)')
}

/**
 * Refreshes an expired Google OAuth access token using a stored refresh token.
 *
 * @param options - Refresh parameters including stored refresh token and client ID.
 * @returns Updated token response with fresh access token.
 */
export async function refreshGoogleToken(
  options: RefreshTokenOptions,
): Promise<GoogleTokenResponse> {
  const endpoint = options.endpoint ?? DEFAULT_TOKEN_ENDPOINT
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  })
  if (options.clientSecret !== undefined) {
    body.set('client_secret', options.clientSecret)
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    ...options.signal !== undefined ? { signal: options.signal } : {},
  })

  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    payload = {}
  }

  if (!response.ok || typeof payload.access_token !== 'string') {
    const errorMsg = (payload.error_description as string | undefined)
      ?? (payload.error as string | undefined)
      ?? (!response.ok ? `HTTP ${response.status}` : 'missing access_token in response')
    throw new Error(`Google OAuth token refresh failed: ${errorMsg}`)
  }

  const expiresInSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600
  const refreshToken = typeof payload.refresh_token === 'string'
    ? payload.refresh_token
    : options.refreshToken

  return {
    access_token: payload.access_token,
    expires_in: expiresInSeconds,
    expires_at: Date.now() + expiresInSeconds * 1000,
    refresh_token: refreshToken,
    ...typeof payload.scope === 'string' ? { scope: payload.scope } : {},
    ...typeof payload.token_type === 'string' ? { token_type: payload.token_type } : { token_type: 'Bearer' },
    ...typeof payload.id_token === 'string' ? { id_token: payload.id_token } : {},
  }
}

/**
 * Determines whether an OAuth token is expired or expiring within the specified safety margin.
 *
 * @param token - Token object containing an `expires_at` or `expiresAt` millisecond timestamp.
 * @param bufferSeconds - Safety margin in seconds (defaults to 300, i.e. 5 minutes).
 * @returns True if the token is expired or will expire within the buffer window; false otherwise.
 */
export function isTokenExpiringSoon(
  token: { expires_at?: number | undefined; expiresAt?: number | undefined },
  bufferSeconds = 300,
): boolean {
  const expiresAt = token.expires_at ?? token.expiresAt
  if (typeof expiresAt !== 'number' || Number.isNaN(expiresAt)) return true
  return Date.now() + bufferSeconds * 1000 >= expiresAt
}
