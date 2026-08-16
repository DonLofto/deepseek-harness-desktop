import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CloudCodeClient,
  DEFAULT_CLOUD_CODE_ENDPOINT,
  DEFAULT_SUBCLIENT_TYPE,
  DEFAULT_IDE_NAME,
} from '../src/cloud-code-client.ts'

function getCallHeaders(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, string> {
  const calls = mock.mock.calls as unknown as Array<[string, RequestInit | undefined]>
  return (calls[callIndex]?.[1]?.headers as Record<string, string> | undefined) ?? {}
}

function getCallBody(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const calls = mock.mock.calls as unknown as Array<[string, RequestInit | undefined]>
  const body = calls[callIndex]?.[1]?.body
  if (typeof body === 'string') {
    return JSON.parse(body) as Record<string, unknown>
  }
  return {}
}

describe('CloudCodeClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor and properties', () => {
    it('initializes with default endpoint and options', () => {
      const client = new CloudCodeClient()
      expect(client.endpoint).toBe(DEFAULT_CLOUD_CODE_ENDPOINT)
      expect(client.subclientType).toBe(DEFAULT_SUBCLIENT_TYPE)
      expect(client.ideName).toBe(DEFAULT_IDE_NAME)
      expect(client.userAgent).toBe(DEFAULT_IDE_NAME)
      expect(client.project).toBeUndefined()
    })

    it('initializes with empty string endpoint by falling back to default', () => {
      const client = new CloudCodeClient('')
      expect(client.endpoint).toBe(DEFAULT_CLOUD_CODE_ENDPOINT)
    })

    it('initializes with a custom string endpoint', () => {
      const client = new CloudCodeClient('https://custom-cloudcode.googleapis.com')
      expect(client.endpoint).toBe('https://custom-cloudcode.googleapis.com')
      expect(client.subclientType).toBe(DEFAULT_SUBCLIENT_TYPE)
    })

    it('initializes with string endpoint and options object', () => {
      const client = new CloudCodeClient('https://custom-cloudcode.googleapis.com/', {
        subclientType: 'custom-subclient',
        ideName: 'custom-ide',
        userAgent: 'custom-ua',
        project: 'projects/p123',
      })
      expect(client.endpoint).toBe('https://custom-cloudcode.googleapis.com/')
      expect(client.subclientType).toBe('custom-subclient')
      expect(client.ideName).toBe('custom-ide')
      expect(client.userAgent).toBe('custom-ua')
      expect(client.project).toBe('projects/p123')
    })

    it('initializes with an options object only', () => {
      const client = new CloudCodeClient({
        endpoint: 'https://opts-cloudcode.googleapis.com',
        subclientType: 'opt-sub',
        ideName: 'opt-ide',
      })
      expect(client.endpoint).toBe('https://opts-cloudcode.googleapis.com')
      expect(client.subclientType).toBe('opt-sub')
      expect(client.ideName).toBe('opt-ide')
    })
  })

  describe('onboardUser', () => {
    it('calls OnboardUser with correct hub subclient headers and returns payload', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          userTier: { id: 'AGY_BUSINESS_PAYGO_TIER', name: 'Gemini Business' },
          cloudaicompanionProject: 'projects/123456789',
          project: 'proj-123',
          location: 'us-central1',
        }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient('https://daily-cloudcode-pa.googleapis.com')
      const res = await client.onboardUser('mock-token')

      expect(res.userTier?.id).toBe('AGY_BUSINESS_PAYGO_TIER')
      expect(res.cloudaicompanionProject).toBe('projects/123456789')
      expect(res.project).toBe('proj-123')
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const headers = getCallHeaders(mockFetch)
      expect(headers['Authorization']).toBe('Bearer mock-token')
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['Accept']).toBe('application/json')
      expect(headers['x-goog-api-client']).toBe('antigravity/hub')
      expect(headers['User-Agent']).toBe('antigravity')

      const body = getCallBody(mockFetch)
      expect(body).toEqual({
        subclientType: 'hub',
        ideName: 'antigravity',
      })
    })

    it('strips trailing slashes from endpoint URL when making requests', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ userTier: { id: 'TIER_1', name: 'Tier 1' } }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient('https://daily-cloudcode-pa.googleapis.com///')
      await client.onboardUser('mock-token')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser',
        expect.anything(),
      )
    })

    it('accepts options object for onboardUser with custom subclient and project header', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ userTier: { id: 'TIER_2', name: 'Tier 2' } }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      const res = await client.onboardUser({
        token: 'mock-token-2',
        project: 'projects/companion-999',
        subclientType: 'desktop',
        ideName: 'custom-ide',
        userAgent: 'custom-agent',
      })

      expect(res.userTier?.id).toBe('TIER_2')
      const headers = getCallHeaders(mockFetch)
      expect(headers['Authorization']).toBe('Bearer mock-token-2')
      expect(headers['x-goog-api-client']).toBe('antigravity/desktop')
      expect(headers['User-Agent']).toBe('custom-agent')
      expect(headers['x-goog-user-project']).toBe('projects/companion-999')

      const body = getCallBody(mockFetch)
      expect(body).toEqual({
        subclientType: 'desktop',
        ideName: 'custom-ide',
        project: 'projects/companion-999',
      })
    })

    it('passes AbortSignal to fetch and honors cancellation', async () => {
      const controller = new AbortController()
      const mockFetch = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new Error('Operation aborted'))
        }
        return Promise.resolve(Response.json({ userTier: { id: 'TIER_1', name: 'Tier 1' } }))
      })
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      controller.abort()

      await expect(client.onboardUser('mock-token', { signal: controller.signal }))
        .rejects.toThrow('Operation aborted')
    })

    it('throws error when token is missing or whitespace only', async () => {
      const client = new CloudCodeClient()
      await expect(client.onboardUser('')).rejects.toThrow(/token is required/i)
      await expect(client.onboardUser('   ')).rejects.toThrow(/token is required/i)
      await expect(client.onboardUser({ token: '' })).rejects.toThrow(/token is required/i)
      await expect(client.onboardUser({ token: undefined })).rejects.toThrow(/token is required/i)
    })

    it('throws descriptive error on HTTP failure with Google RPC error message', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 403,
              message: 'Caller does not have required permissions',
              status: 'PERMISSION_DENIED',
            },
          },
          { status: 403, statusText: 'Forbidden' },
        ),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      await expect(client.onboardUser('mock-token')).rejects.toThrow(
        'Cloud Code PA OnboardUser failed (403): Caller does not have required permissions',
      )
    })

    it('throws descriptive error on HTTP failure when body is invalid JSON', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('Internal server error HTML', { status: 502, statusText: 'Bad Gateway' }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      await expect(client.onboardUser('mock-token')).rejects.toThrow(
        'Cloud Code PA OnboardUser failed (502): Bad Gateway',
      )
    })

    it('falls back to statusText when error object has no message string', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ error: { code: 500 } }, { status: 500, statusText: 'Internal Server Error' }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      await expect(client.onboardUser('mock-token')).rejects.toThrow(
        'Cloud Code PA OnboardUser failed (500): Internal Server Error',
      )
    })
  })

  describe('retrieveUserQuotaSummary', () => {
    it('calls retrieveUserQuotaSummary with project in body and headers', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          userTier: 'AGY_BUSINESS_PAYGO_TIER',
          remainingCredits: 500,
          capacityExhausted: false,
        }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient('https://daily-cloudcode-pa.googleapis.com')
      const res = await client.retrieveUserQuotaSummary('mock-token', 'projects/my-proj')

      expect(res.userTier).toBe('AGY_BUSINESS_PAYGO_TIER')
      expect(res.remainingCredits).toBe(500)
      expect(res.capacityExhausted).toBe(false)

      const headers = getCallHeaders(mockFetch)
      expect(headers['Authorization']).toBe('Bearer mock-token')
      expect(headers['x-goog-api-client']).toBe('antigravity/hub')
      expect(headers['User-Agent']).toBe('antigravity')
      expect(headers['x-goog-user-project']).toBe('projects/my-proj')

      const body = getCallBody(mockFetch)
      expect(body).toEqual({ project: 'projects/my-proj' })
    })

    it('calls retrieveUserQuotaSummary using options object without project', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          userTier: 'FREE_TIER',
          capacityExhausted: true,
        }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      const res = await client.retrieveUserQuotaSummary({
        token: 'mock-token',
      })

      expect(res.userTier).toBe('FREE_TIER')
      expect(res.capacityExhausted).toBe(true)

      const headers = getCallHeaders(mockFetch)
      expect(headers['x-goog-user-project']).toBeUndefined()

      const body = getCallBody(mockFetch)
      expect(body).toEqual({})
    })

    it('uses client default project when method call omits project', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ userTier: 'TIER_1' }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient({
        project: 'projects/default-proj',
      })
      await client.retrieveUserQuotaSummary('mock-token')

      const headers = getCallHeaders(mockFetch)
      expect(headers['x-goog-user-project']).toBe('projects/default-proj')

      const body = getCallBody(mockFetch)
      expect(body).toEqual({ project: 'projects/default-proj' })
    })

    it('throws error when token is missing', async () => {
      const client = new CloudCodeClient()
      await expect(client.retrieveUserQuotaSummary('')).rejects.toThrow(/token is required/i)
      await expect(client.retrieveUserQuotaSummary({ token: '' })).rejects.toThrow(/token is required/i)
      await expect(client.retrieveUserQuotaSummary({ token: undefined })).rejects.toThrow(/token is required/i)
    })

    it('throws descriptive error on HTTP failure', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ error: 'Invalid authentication credentials' }, { status: 401, statusText: 'Unauthorized' }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      await expect(client.retrieveUserQuotaSummary('bad-token')).rejects.toThrow(
        'Cloud Code PA RetrieveUserQuotaSummary failed (401): Invalid authentication credentials',
      )
    })
  })

  describe('listModelConfigs', () => {
    it('calls listModelConfigs and returns available models', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          modelConfigs: [
            {
              id: 'gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              inputTokenLimit: 2097152,
              outputTokenLimit: 8192,
              isAvailable: true,
            },
            {
              id: 'gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              inputTokenLimit: 1048576,
              outputTokenLimit: 8192,
              isAvailable: true,
            },
          ],
        }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient('https://daily-cloudcode-pa.googleapis.com')
      const res = await client.listModelConfigs('mock-token', 'projects/proj-1')

      expect(res.modelConfigs).toHaveLength(2)
      expect(res.modelConfigs?.[0]?.id).toBe('gemini-2.5-pro')
      expect(res.modelConfigs?.[1]?.displayName).toBe('Gemini 2.5 Flash')

      const headers = getCallHeaders(mockFetch)
      expect(headers['Authorization']).toBe('Bearer mock-token')
      expect(headers['x-goog-api-client']).toBe('antigravity/hub')
      expect(headers['User-Agent']).toBe('antigravity')
      expect(headers['x-goog-user-project']).toBe('projects/proj-1')

      const body = getCallBody(mockFetch)
      expect(body).toEqual({ project: 'projects/proj-1' })
    })

    it('calls listModelConfigs using options object with custom fetch', async () => {
      const customFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          models: [{ id: 'gemini-3.1-pro-preview', isAvailable: true }],
        }),
      )

      const client = new CloudCodeClient({
        fetch: customFetch,
      })

      const res = await client.listModelConfigs({
        token: 'mock-token-custom',
        project: 'projects/custom-p',
      })

      expect(res.models?.[0]?.id).toBe('gemini-3.1-pro-preview')
      expect(customFetch).toHaveBeenCalledTimes(1)
    })

    it('throws error when token is missing', async () => {
      const client = new CloudCodeClient()
      await expect(client.listModelConfigs('')).rejects.toThrow(/token is required/i)
      await expect(client.listModelConfigs({ token: undefined })).rejects.toThrow(/token is required/i)
    })

    it('throws descriptive error on HTTP failure with error_description', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ error_description: 'Resource not found' }, { status: 404, statusText: 'Not Found' }),
      )
      globalThis.fetch = mockFetch

      const client = new CloudCodeClient()
      await expect(client.listModelConfigs('mock-token')).rejects.toThrow(
        'Cloud Code PA ListModelConfigs failed (404): Resource not found',
      )
    })
  })
})
