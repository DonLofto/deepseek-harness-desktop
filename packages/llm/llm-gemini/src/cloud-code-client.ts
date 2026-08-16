/**
 * Client for Google Cloud Code PA internal API (onboarding, entitlements, quota, and model configurations).
 * @module @deepseek-ai/dsh-llm-gemini/cloud-code-client
 */

import {
  DEFAULT_CLOUD_CODE_ENDPOINT,
  DEFAULT_SUBCLIENT_TYPE,
  DEFAULT_IDE_NAME,
} from './config.ts'
import type {
  OnboardUserResponse,
  QuotaSummary,
  ListModelConfigsResponse,
} from './types.ts'

export {
  DEFAULT_CLOUD_CODE_ENDPOINT,
  DEFAULT_SUBCLIENT_TYPE,
  DEFAULT_IDE_NAME,
}

/**
 * Options for configuring a {@link CloudCodeClient} instance.
 */
export interface CloudCodeClientOptions {
  /** Base URL for Cloud Code PA endpoint. Defaults to `DEFAULT_CLOUD_CODE_ENDPOINT`. */
  endpoint?: string | undefined
  /** Subclient type identifier sent in metadata headers and payloads. Defaults to `DEFAULT_SUBCLIENT_TYPE`. */
  subclientType?: string | undefined
  /** Client IDE name identifier. Defaults to `DEFAULT_IDE_NAME`. */
  ideName?: string | undefined
  /** User-Agent header value sent on requests. Defaults to `DEFAULT_IDE_NAME`. */
  userAgent?: string | undefined
  /** Default Google Cloud companion project ID when omitted from requests. */
  project?: string | undefined
  /** Custom fetch implementation for mocking or transport interception. */
  fetch?: typeof fetch | undefined
}

/**
 * Common request options for Cloud Code PA RPC methods.
 */
export interface CloudCodeRequestOptions {
  /** Target Google Cloud project identifier. */
  project?: string | undefined
  /** Subclient type identifier override for this call. */
  subclientType?: string | undefined
  /** IDE name identifier override for this call. */
  ideName?: string | undefined
  /** User-Agent header value override for this call. */
  userAgent?: string | undefined
  /** Optional AbortSignal for request cancellation. */
  signal?: AbortSignal | undefined
}

/**
 * Options for {@link CloudCodeClient.onboardUser}.
 */
export interface OnboardUserOptions extends CloudCodeRequestOptions {
  /** OAuth bearer access token. */
  token?: string | undefined
}

/**
 * Options for {@link CloudCodeClient.retrieveUserQuotaSummary}.
 */
export interface RetrieveUserQuotaSummaryOptions extends CloudCodeRequestOptions {
  /** OAuth bearer access token. */
  token?: string | undefined
}

/**
 * Options for {@link CloudCodeClient.listModelConfigs}.
 */
export interface ListModelConfigsOptions extends CloudCodeRequestOptions {
  /** OAuth bearer access token. */
  token?: string | undefined
}

/**
 * Client for invoking Google Cloud Code PA `/v1internal:*` RPC endpoints.
 */
export class CloudCodeClient {
  /** Configured Cloud Code PA base endpoint. */
  readonly endpoint: string
  /** Subclient type identifier. */
  readonly subclientType: string
  /** Client IDE name identifier. */
  readonly ideName: string
  /** User-Agent header value sent on RPC requests. */
  readonly userAgent: string
  /** Default Google Cloud companion project identifier. */
  readonly project: string | undefined
  /** Custom fetch implementation. */
  private readonly customFetch: typeof fetch | undefined

  /**
   * Constructs a new {@link CloudCodeClient}.
   *
   * @param endpointOrOptions - Endpoint URL string or options object.
   * @param options - Additional options when passing endpoint string as first argument.
   */
  constructor(
    endpointOrOptions?: string | CloudCodeClientOptions,
    options?: CloudCodeClientOptions,
  ) {
    if (typeof endpointOrOptions === 'string') {
      this.endpoint = endpointOrOptions || DEFAULT_CLOUD_CODE_ENDPOINT
      this.subclientType = options?.subclientType ?? DEFAULT_SUBCLIENT_TYPE
      this.ideName = options?.ideName ?? DEFAULT_IDE_NAME
      this.userAgent = options?.userAgent ?? DEFAULT_IDE_NAME
      this.project = options?.project
      this.customFetch = options?.fetch
    } else if (typeof endpointOrOptions === 'object') {
      this.endpoint = endpointOrOptions.endpoint ?? DEFAULT_CLOUD_CODE_ENDPOINT
      this.subclientType = endpointOrOptions.subclientType ?? DEFAULT_SUBCLIENT_TYPE
      this.ideName = endpointOrOptions.ideName ?? DEFAULT_IDE_NAME
      this.userAgent = endpointOrOptions.userAgent ?? DEFAULT_IDE_NAME
      this.project = endpointOrOptions.project
      this.customFetch = endpointOrOptions.fetch
    } else {
      this.endpoint = DEFAULT_CLOUD_CODE_ENDPOINT
      this.subclientType = DEFAULT_SUBCLIENT_TYPE
      this.ideName = DEFAULT_IDE_NAME
      this.userAgent = DEFAULT_IDE_NAME
      this.project = undefined
      this.customFetch = undefined
    }
  }

  /**
   * Builds a normalized absolute URL for a Cloud Code PA RPC path.
   *
   * @param path - RPC subpath (e.g. `/v1internal:onboardUser`).
   * @returns Fully resolved URL string.
   */
  private buildUrl(path: string): string {
    const base = this.endpoint.replace(/\/+$/, '')
    return `${base}${path}`
  }

  /**
   * Executes a POST RPC request against the Cloud Code PA endpoint with proper metadata headers.
   *
   * @param rpcName - Method name for error diagnostic reporting.
   * @param path - RPC endpoint path.
   * @param token - OAuth bearer access token.
   * @param body - JSON payload object.
   * @param options - Optional request headers and cancellation signal.
   * @returns Deserialized response payload.
   */
  private async executeRpc<T>(
    rpcName: string,
    path: string,
    token: string,
    body: Record<string, unknown>,
    options?: CloudCodeRequestOptions,
  ): Promise<T> {
    if (!token || token.trim() === '') {
      throw new Error(`Access token is required for ${rpcName}`)
    }

    const subclient = options?.subclientType ?? this.subclientType
    const userAgent = options?.userAgent ?? this.userAgent
    const project = options?.project ?? this.project

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-goog-api-client': `antigravity/${subclient}`,
      'User-Agent': userAgent,
    }

    if (project) {
      headers['x-goog-user-project'] = project
    }

    const fetchFn = this.customFetch ?? globalThis.fetch
    const response = await fetchFn(this.buildUrl(path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...options?.signal !== undefined ? { signal: options.signal } : {},
    })

    let payload: Record<string, unknown>
    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      payload = {}
    }

    if (!response.ok) {
      const errorObj = typeof payload.error === 'object' && payload.error !== null
        ? (payload.error as Record<string, unknown>)
        : undefined
      const errorDetail = (typeof errorObj?.message === 'string' ? errorObj.message : undefined)
        ?? (typeof payload.error_description === 'string' ? payload.error_description : undefined)
        ?? (typeof payload.error === 'string' ? payload.error : undefined)
        ?? response.statusText
      throw new Error(`Cloud Code PA ${rpcName} failed (${response.status}): ${errorDetail}`)
    }

    return payload as unknown as T
  }

  /**
   * Onboards the authenticated user with Cloud Code PA to retrieve tier entitlement,
   * primary project ID, and companion project resource paths.
   *
   * @param tokenOrOptions - OAuth bearer access token or {@link OnboardUserOptions} object.
   * @param options - Request options when passing token as first argument.
   * @returns Resolved user subscription tier and companion project information.
   */
  async onboardUser(
    tokenOrOptions: string | OnboardUserOptions,
    options?: CloudCodeRequestOptions,
  ): Promise<OnboardUserResponse> {
    const isString = typeof tokenOrOptions === 'string'
    const token = isString ? tokenOrOptions : tokenOrOptions.token ?? ''
    const reqOptions: CloudCodeRequestOptions = isString ? (options ?? {}) : tokenOrOptions

    const subclientType = reqOptions.subclientType ?? this.subclientType
    const ideName = reqOptions.ideName ?? this.ideName
    const project = reqOptions.project ?? this.project

    const body: Record<string, unknown> = {
      subclientType,
      ideName,
      ...(project ? { project } : {}),
    }

    return this.executeRpc<OnboardUserResponse>(
      'OnboardUser',
      '/v1internal:onboardUser',
      token,
      body,
      reqOptions,
    )
  }

  /**
   * Retrieves quota summary and credit utilization status for the user and project.
   *
   * @param tokenOrOptions - OAuth bearer access token or {@link RetrieveUserQuotaSummaryOptions} object.
   * @param projectOrOptions - Target project identifier or request options.
   * @param options - Request options when passing token and project as positional arguments.
   * @returns Quota summary including remaining credits and capacity exhaustion flags.
   */
  async retrieveUserQuotaSummary(
    tokenOrOptions: string | RetrieveUserQuotaSummaryOptions,
    projectOrOptions?: string | CloudCodeRequestOptions,
    options?: CloudCodeRequestOptions,
  ): Promise<QuotaSummary> {
    let token: string
    let reqOptions: CloudCodeRequestOptions

    if (typeof tokenOrOptions === 'string') {
      token = tokenOrOptions
      if (typeof projectOrOptions === 'string') {
        reqOptions = { project: projectOrOptions, ...options }
      } else {
        reqOptions = projectOrOptions ?? {}
      }
    } else {
      token = tokenOrOptions.token ?? ''
      reqOptions = tokenOrOptions
    }

    const project = reqOptions.project ?? this.project
    const body: Record<string, unknown> = project ? { project } : {}

    return this.executeRpc<QuotaSummary>(
      'RetrieveUserQuotaSummary',
      '/v1internal:retrieveUserQuotaSummary',
      token,
      body,
      reqOptions,
    )
  }

  /**
   * Lists model configurations and capability metadata authorized for the user's tier and companion project.
   *
   * @param tokenOrOptions - OAuth bearer access token or {@link ListModelConfigsOptions} object.
   * @param projectOrOptions - Target project identifier or request options.
   * @param options - Request options when passing token and project as positional arguments.
   * @returns List of model configurations available for inference.
   */
  async listModelConfigs(
    tokenOrOptions: string | ListModelConfigsOptions,
    projectOrOptions?: string | CloudCodeRequestOptions,
    options?: CloudCodeRequestOptions,
  ): Promise<ListModelConfigsResponse> {
    let token: string
    let reqOptions: CloudCodeRequestOptions

    if (typeof tokenOrOptions === 'string') {
      token = tokenOrOptions
      if (typeof projectOrOptions === 'string') {
        reqOptions = { project: projectOrOptions, ...options }
      } else {
        reqOptions = projectOrOptions ?? {}
      }
    } else {
      token = tokenOrOptions.token ?? ''
      reqOptions = tokenOrOptions
    }

    const project = reqOptions.project ?? this.project
    const body: Record<string, unknown> = project ? { project } : {}

    return this.executeRpc<ListModelConfigsResponse>(
      'ListModelConfigs',
      '/v1internal:listModelConfigs',
      token,
      body,
      reqOptions,
    )
  }
}
