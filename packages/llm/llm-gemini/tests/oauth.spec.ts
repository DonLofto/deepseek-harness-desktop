import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_DEVICE_AUTH_ENDPOINT,
  DEFAULT_GOOGLE_OAUTH_SCOPES,
  DEFAULT_TOKEN_ENDPOINT,
  initiateGoogleDeviceFlow,
  isTokenExpiringSoon,
  pollGoogleDeviceToken,
  refreshGoogleToken,
  sleep,
} from '../src/oauth.ts'

function getCallBodyParams(mock: ReturnType<typeof vi.fn>): URLSearchParams {
  const calls = mock.mock.calls as unknown as Array<[string, RequestInit | undefined]>
  const body = calls[0]?.[1]?.body
  return new URLSearchParams(typeof body === 'string' ? body : '')
}

describe('Google OAuth Device Flow & Token Management', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('sleep', () => {
    it('resolves after specified milliseconds when no signal is given', async () => {
      vi.useFakeTimers()
      const p = sleep(500)
      await vi.advanceTimersByTimeAsync(500)
      await expect(p).resolves.toBeUndefined()
    })

    it('throws immediately when signal is already aborted with reason', async () => {
      const controller = new AbortController()
      controller.abort(new Error('Pre-aborted sleep'))
      await expect(sleep(500, controller.signal)).rejects.toThrow('Pre-aborted sleep')
    })

    it('throws immediately when signal is already aborted with string reason', async () => {
      const controller = new AbortController()
      controller.abort('String abort reason')
      await expect(sleep(500, controller.signal)).rejects.toThrow('String abort reason')
    })

    it('throws immediately when signal is already aborted without reason', async () => {
      const signal = { aborted: true } as AbortSignal
      await expect(sleep(500, signal)).rejects.toThrow('Operation aborted')
    })

    it('rejects with custom error when aborted while timer is pending', async () => {
      vi.useFakeTimers()
      const controller = new AbortController()
      const p = sleep(1000, controller.signal)
      const assertion = expect(p).rejects.toThrow('Interrupted sleep')
      await vi.advanceTimersByTimeAsync(200)
      controller.abort(new Error('Interrupted sleep'))
      await assertion
    })

    it('rejects with default error when aborted without reason while timer is pending', async () => {
      vi.useFakeTimers()
      const listeners: Array<() => void> = []
      const fakeSignal = {
        aborted: false,
        reason: undefined,
        addEventListener: (_event: string, cb: () => void) => {
          listeners.push(cb)
        },
        removeEventListener: vi.fn(),
      } as unknown as AbortSignal

      const p = sleep(1000, fakeSignal)
      const assertion = expect(p).rejects.toThrow('Operation aborted')
      await vi.advanceTimersByTimeAsync(200)
      for (const cb of listeners) cb()
      await assertion
    })
  })

  describe('initiateGoogleDeviceFlow', () => {
    it('initiates device code flow with default scopes and canonical endpoint', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          device_code: 'dev_123',
          user_code: 'ABCD-EFGH',
          verification_url: 'https://www.google.com/device',
          expires_in: 1800,
          interval: 5,
        }),
      )
      globalThis.fetch = mockFetch

      const res = await initiateGoogleDeviceFlow({ clientId: 'test-client' })

      expect(res.device_code).toBe('dev_123')
      expect(res.user_code).toBe('ABCD-EFGH')
      expect(res.verification_url).toBe('https://www.google.com/device')
      expect(res.verification_uri).toBe('https://www.google.com/device')
      expect(res.expires_in).toBe(1800)
      expect(res.interval).toBe(5)

      expect(mockFetch).toHaveBeenCalledWith(
        DEFAULT_DEVICE_AUTH_ENDPOINT,
        expect.objectContaining({
          method: 'POST',
        }),
      )

      const params = getCallBodyParams(mockFetch)
      expect(params.get('client_id')).toBe('test-client')
      expect(params.get('scope')).toBe(DEFAULT_GOOGLE_OAUTH_SCOPES.join(' '))
      expect(params.get('client_secret')).toBeNull()
    })

    it('uses fallback default clientId, custom scopes, clientSecret, and endpoint', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          device_code: 'dev_456',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://custom.auth/device',
          expires_in: 900,
          interval: 10,
        }),
      )
      globalThis.fetch = mockFetch

      const res = await initiateGoogleDeviceFlow({
        clientSecret: 'secret_xyz',
        scopes: ['openid', 'email'],
        endpoint: 'https://custom.auth/device/code',
      })

      expect(res.device_code).toBe('dev_456')
      expect(res.user_code).toBe('WXYZ-1234')
      expect(res.verification_url).toBe('https://custom.auth/device')
      expect(res.verification_uri).toBe('https://custom.auth/device')

      const params = getCallBodyParams(mockFetch)
      expect(params.get('client_id')).toBe(DEFAULT_CLIENT_ID)
      expect(params.get('client_secret')).toBe('secret_xyz')
      expect(params.get('scope')).toBe('openid email')
    })

    it('supplies default expires_in and interval if missing from response', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          device_code: 'dev_789',
          user_code: '1234-5678',
        }),
      )
      globalThis.fetch = mockFetch

      const res = await initiateGoogleDeviceFlow()
      expect(res.expires_in).toBe(1800)
      expect(res.interval).toBe(5)
      expect(res.verification_url).toBe('')
      expect(res.verification_uri).toBeUndefined()
    })

    it('throws error when response is not ok with error_description', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: 'invalid_client',
            error_description: 'Client is invalid',
          },
          { status: 400, statusText: 'Bad Request' },
        ),
      )
      globalThis.fetch = mockFetch

      await expect(initiateGoogleDeviceFlow()).rejects.toThrow(
        'Google OAuth device flow initiation failed (400): Client is invalid',
      )
    })

    it('throws error when response is not ok with error code only', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: 'access_denied',
          },
          { status: 403, statusText: 'Forbidden' },
        ),
      )
      globalThis.fetch = mockFetch

      await expect(initiateGoogleDeviceFlow()).rejects.toThrow(
        'Google OAuth device flow initiation failed (403): access_denied',
      )
    })

    it('throws error when response is not ok and json parse fails', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      )
      globalThis.fetch = mockFetch

      await expect(initiateGoogleDeviceFlow()).rejects.toThrow(
        'Google OAuth device flow initiation failed (502): Bad Gateway',
      )
    })

    it('throws error if response is missing device_code', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          user_code: '1234',
        }),
      )
      globalThis.fetch = mockFetch

      await expect(initiateGoogleDeviceFlow()).rejects.toThrow(
        'Google OAuth device flow response missing device_code or user_code',
      )
    })

    it('throws error if response is missing user_code', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          device_code: 'dev_123',
        }),
      )
      globalThis.fetch = mockFetch

      await expect(initiateGoogleDeviceFlow()).rejects.toThrow(
        'Google OAuth device flow response missing device_code or user_code',
      )
    })

    it('passes abort signal to fetch', async () => {
      const controller = new AbortController()
      const mockFetch = vi.fn<typeof fetch>().mockImplementation((_url, opts) => {
        if (opts?.signal?.aborted) {
          return Promise.reject(new Error('Aborted'))
        }
        return Promise.resolve(
          Response.json({
            device_code: 'dev_1',
            user_code: '123',
            verification_url: 'https://device',
          }),
        )
      })
      globalThis.fetch = mockFetch

      controller.abort()
      await expect(initiateGoogleDeviceFlow({ signal: controller.signal })).rejects.toThrow()
    })
  })

  describe('pollGoogleDeviceToken', () => {
    it('returns token immediately on first successful poll with all fields populated', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          access_token: 'ya29.mock_access',
          expires_in: 3600,
          refresh_token: '1//mock_refresh',
          scope: 'openid email',
          token_type: 'Bearer',
          id_token: 'mock.jwt.token',
        }),
      )
      globalThis.fetch = mockFetch

      const before = Date.now()
      const token = await pollGoogleDeviceToken({
        clientId: 'test-client',
        deviceCode: 'dev_123',
        clientSecret: 'test-secret',
      })
      const after = Date.now()

      expect(token.access_token).toBe('ya29.mock_access')
      expect(token.expires_in).toBe(3600)
      expect(token.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000)
      expect(token.expires_at).toBeLessThanOrEqual(after + 3600 * 1000)
      expect(token.refresh_token).toBe('1//mock_refresh')
      expect(token.scope).toBe('openid email')
      expect(token.token_type).toBe('Bearer')
      expect(token.id_token).toBe('mock.jwt.token')

      const params = getCallBodyParams(mockFetch)
      expect(params.get('client_id')).toBe('test-client')
      expect(params.get('client_secret')).toBe('test-secret')
      expect(params.get('device_code')).toBe('dev_123')
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    })

    it('uses fallback token defaults when optional fields are omitted in successful response', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          access_token: 'ya29.minimal_access',
        }),
      )
      globalThis.fetch = mockFetch

      const res = await pollGoogleDeviceToken({ deviceCode: 'dev_minimal' })
      expect(res.access_token).toBe('ya29.minimal_access')
      expect(res.expires_in).toBe(3600)
      expect(res.token_type).toBe('Bearer')
      expect(res.refresh_token).toBeUndefined()
      expect(res.scope).toBeUndefined()
      expect(res.id_token).toBeUndefined()
    })

    it('handles authorization_pending then succeeds on subsequent poll', async () => {
      vi.useFakeTimers()

      let callCount = 0
      const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return Response.json({ error: 'authorization_pending' }, { status: 400 })
        }
        return Response.json({
          access_token: 'ya29.final_access',
          expires_in: 3600,
        })
      })
      globalThis.fetch = mockFetch

      const promise = pollGoogleDeviceToken({
        deviceCode: 'dev_poll',
        interval: 2,
      })

      // First call happens immediately
      await vi.advanceTimersByTimeAsync(100)
      expect(callCount).toBe(1)

      // Advance by interval (2000ms)
      await vi.advanceTimersByTimeAsync(2000)
      const res = await promise

      expect(res.access_token).toBe('ya29.final_access')
      expect(callCount).toBe(2)
    })

    it('handles slow_down by increasing interval and continuing', async () => {
      vi.useFakeTimers()

      let callCount = 0
      const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return Response.json({ error: 'slow_down' }, { status: 400 })
        }
        return Response.json({
          access_token: 'ya29.slow_access',
          expires_in: 3600,
        })
      })
      globalThis.fetch = mockFetch

      const promise = pollGoogleDeviceToken({
        deviceCode: 'dev_slow',
        interval: 5,
      })

      await vi.advanceTimersByTimeAsync(100)
      expect(callCount).toBe(1)

      // slow_down increases interval by 5, so new interval is 10s (10000ms)
      await vi.advanceTimersByTimeAsync(5000)
      expect(callCount).toBe(1)

      await vi.advanceTimersByTimeAsync(5000)
      const res = await promise

      expect(res.access_token).toBe('ya29.slow_access')
      expect(callCount).toBe(2)
    })

    it('throws error immediately on expired_token', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ error: 'expired_token' }, { status: 400 }),
      )
      globalThis.fetch = mockFetch

      await expect(
        pollGoogleDeviceToken({ deviceCode: 'dev_exp' }),
      ).rejects.toThrow('Google OAuth device authorization expired (expired_token)')
    })

    it('throws error immediately on access_denied', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ error: 'access_denied' }, { status: 400 }),
      )
      globalThis.fetch = mockFetch

      await expect(
        pollGoogleDeviceToken({ deviceCode: 'dev_denied' }),
      ).rejects.toThrow('Google OAuth device authorization was denied by the user (access_denied)')
    })

    it('throws error immediately on other OAuth failure with error_description', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: 'invalid_client',
            error_description: 'Unauthorized client',
          },
          { status: 401 },
        ),
      )
      globalThis.fetch = mockFetch

      await expect(
        pollGoogleDeviceToken({ deviceCode: 'dev_invalid' }),
      ).rejects.toThrow('Google OAuth device token polling failed: Unauthorized client')
    })

    it('throws error immediately on other OAuth failure with error code only', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: 'unsupported_grant_type',
          },
          { status: 400 },
        ),
      )
      globalThis.fetch = mockFetch

      await expect(
        pollGoogleDeviceToken({ deviceCode: 'dev_invalid' }),
      ).rejects.toThrow('Google OAuth device token polling failed: unsupported_grant_type')
    })

    it('throws error when token endpoint returns non-JSON error', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('500 Error', { status: 500, statusText: 'Internal Server Error' }),
      )
      globalThis.fetch = mockFetch

      await expect(
        pollGoogleDeviceToken({ deviceCode: 'dev_500' }),
      ).rejects.toThrow('Google OAuth device token polling failed: HTTP 500')
    })

    it('throws error when aborted before polling loop starts with default fallback error', async () => {
      const signal = { aborted: true } as AbortSignal

      await expect(
        pollGoogleDeviceToken({
          deviceCode: 'dev_aborted',
          signal,
        }),
      ).rejects.toThrow('Operation aborted')
    })

    it('throws custom abort reason when signal is already aborted with a reason', async () => {
      const controller = new AbortController()
      controller.abort(new Error('Custom abort pre-flight'))

      await expect(
        pollGoogleDeviceToken({
          deviceCode: 'dev_aborted_custom',
          signal: controller.signal,
        }),
      ).rejects.toThrow('Custom abort pre-flight')
    })

    it('cancels pending poll sleep when signal is aborted mid-wait with reason', async () => {
      vi.useFakeTimers()

      const controller = new AbortController()
      const mockFetch = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(Response.json({ error: 'authorization_pending' }, { status: 400 })),
      )
      globalThis.fetch = mockFetch

      const promise = pollGoogleDeviceToken({
        deviceCode: 'dev_abort_mid',
        interval: 10,
        signal: controller.signal,
      })
      const assertion = expect(promise).rejects.toThrow('User cancelled login')

      // Run initial fetch
      await vi.advanceTimersByTimeAsync(50)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Abort while waiting in sleep
      controller.abort(new Error('User cancelled login'))

      await assertion
    })

    it('cancels pending poll sleep when signal is aborted mid-wait with default reason', async () => {
      vi.useFakeTimers()

      const controller = new AbortController()
      const mockFetch = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(Response.json({ error: 'authorization_pending' }, { status: 400 })),
      )
      globalThis.fetch = mockFetch

      const promise = pollGoogleDeviceToken({
        deviceCode: 'dev_abort_mid_no_reason',
        interval: 10,
        signal: controller.signal,
      })
      const assertion = expect(promise).rejects.toThrow()

      await vi.advanceTimersByTimeAsync(50)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      controller.abort()

      await assertion
    })

    it('times out when deadline is reached', async () => {
      vi.useFakeTimers()

      const mockFetch = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(Response.json({ error: 'authorization_pending' }, { status: 400 })),
      )
      globalThis.fetch = mockFetch

      const promise = pollGoogleDeviceToken({
        deviceCode: 'dev_timeout',
        interval: 5,
        expiresIn: 10,
      })
      const assertion = expect(promise).rejects.toThrow(
        'Google OAuth device authorization timed out (expired_token)',
      )

      await vi.advanceTimersByTimeAsync(50)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5000)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(6000)
      await assertion
    })
  })

  describe('refreshGoogleToken', () => {
    it('successfully refreshes token and preserves previous refreshToken if omitted in response', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          access_token: 'ya29.refreshed_access',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/generative-language',
        }),
      )
      globalThis.fetch = mockFetch

      const res = await refreshGoogleToken({
        refreshToken: '1//existing_refresh',
        clientId: 'custom_id',
      })

      expect(res.access_token).toBe('ya29.refreshed_access')
      expect(res.expires_in).toBe(3600)
      expect(res.refresh_token).toBe('1//existing_refresh')
      expect(res.token_type).toBe('Bearer')
      expect(res.scope).toBe('https://www.googleapis.com/auth/generative-language')

      expect(mockFetch).toHaveBeenCalledWith(
        DEFAULT_TOKEN_ENDPOINT,
        expect.objectContaining({
          method: 'POST',
        }),
      )
      const params = getCallBodyParams(mockFetch)
      expect(params.get('client_id')).toBe('custom_id')
      expect(params.get('grant_type')).toBe('refresh_token')
      expect(params.get('refresh_token')).toBe('1//existing_refresh')
      expect(params.get('client_secret')).toBeNull()
    })

    it('updates refresh token and sets defaults when token_type is omitted in refresh response', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          access_token: 'ya29.refreshed_access_2',
          refresh_token: '1//new_rotated_refresh',
          id_token: 'new.id.token',
        }),
      )
      globalThis.fetch = mockFetch

      const controller = new AbortController()
      const res = await refreshGoogleToken({
        refreshToken: '1//old_refresh',
        clientSecret: 'secret_123',
        endpoint: 'https://custom.oauth/token',
        signal: controller.signal,
      })

      expect(res.access_token).toBe('ya29.refreshed_access_2')
      expect(res.expires_in).toBe(3600)
      expect(res.refresh_token).toBe('1//new_rotated_refresh')
      expect(res.token_type).toBe('Bearer')
      expect(res.id_token).toBe('new.id.token')

      const params = getCallBodyParams(mockFetch)
      expect(params.get('client_secret')).toBe('secret_123')
    })

    it('throws error when refresh fails with error_description', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          },
          { status: 400 },
        ),
      )
      globalThis.fetch = mockFetch

      await expect(
        refreshGoogleToken({ refreshToken: '1//revoked' }),
      ).rejects.toThrow('Google OAuth token refresh failed: Token has been expired or revoked.')
    })

    it('throws error when refresh fails with error code only', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: 'invalid_client',
          },
          { status: 400 },
        ),
      )
      globalThis.fetch = mockFetch

      await expect(
        refreshGoogleToken({ refreshToken: '1//invalid_client' }),
      ).rejects.toThrow('Google OAuth token refresh failed: invalid_client')
    })

    it('throws error when response json is missing access_token on ok status', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          expires_in: 3600,
        }),
      )
      globalThis.fetch = mockFetch

      await expect(
        refreshGoogleToken({ refreshToken: '1//token' }),
      ).rejects.toThrow('Google OAuth token refresh failed: missing access_token in response')
    })

    it('throws error when network or json error occurs on non-ok status', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }),
      )
      globalThis.fetch = mockFetch

      await expect(
        refreshGoogleToken({ refreshToken: '1//token' }),
      ).rejects.toThrow('Google OAuth token refresh failed: HTTP 503')
    })
  })

  describe('isTokenExpiringSoon', () => {
    it('returns true when token has no expiration or invalid expiration timestamp', () => {
      expect(isTokenExpiringSoon({})).toBe(true)
      expect(isTokenExpiringSoon({ expires_at: NaN })).toBe(true)
      expect(isTokenExpiringSoon({ expires_at: '2026-01-01' as unknown as number })).toBe(true)
    })

    it('returns true when token is already expired', () => {
      expect(isTokenExpiringSoon({ expires_at: Date.now() - 1000 })).toBe(true)
      expect(isTokenExpiringSoon({ expiresAt: Date.now() - 1000 })).toBe(true)
    })

    it('returns true when token expires within buffer margin (default 300s)', () => {
      expect(isTokenExpiringSoon({ expires_at: Date.now() + 200 * 1000 })).toBe(true)
    })

    it('returns false when token has plenty of validity remaining', () => {
      expect(isTokenExpiringSoon({ expires_at: Date.now() + 3600 * 1000 })).toBe(false)
      expect(isTokenExpiringSoon({ expiresAt: Date.now() + 3600 * 1000 })).toBe(false)
    })

    it('honors custom bufferSeconds argument', () => {
      // 100s remaining, buffer 50s -> false
      expect(isTokenExpiringSoon({ expires_at: Date.now() + 100 * 1000 }, 50)).toBe(false)
      // 100s remaining, buffer 150s -> true
      expect(isTokenExpiringSoon({ expires_at: Date.now() + 100 * 1000 }, 150)).toBe(true)
    })
  })
})
