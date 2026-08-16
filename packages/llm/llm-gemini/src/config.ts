/**
 * Configuration schema and defaults for Google Gemini and Cloud Code PA.
 * @module @deepseek-ai/dsh-llm-gemini/config
 */

import z from '@deepseek-ai/schemastery'

/** Canonical default Cloud Code PA endpoint. */
export const DEFAULT_CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'

/** Canonical default Gemini API server URL. */
export const DEFAULT_API_SERVER_URL = 'https://generativelanguage.googleapis.com'

/** Canonical default subclient type for Cloud Code PA calls. */
export const DEFAULT_SUBCLIENT_TYPE = 'hub'

/** Canonical default IDE name for Cloud Code PA calls. */
export const DEFAULT_IDE_NAME = 'antigravity'

/**
 * Raw configuration options for the Gemini LLM provider.
 */
export interface GeminiConfig {
  /** Cloud Code PA endpoint for onboarding, entitlements, and quota synchronization. */
  cloudCodeEndpoint?: string
  /** Gemini API server URL for model streaming inference. */
  apiServerUrl?: string
  /** Hub or IDE client type passed to Cloud Code PA. */
  subclientType?: string
  /** Client IDE name passed to Cloud Code PA. */
  ideName?: string
}

export type Config = GeminiConfig

/**
 * Schemastery schema validating and defaulting {@link GeminiConfig}.
 */
export const Config: z<GeminiConfig> = z.object({
  cloudCodeEndpoint: z.string().default(DEFAULT_CLOUD_CODE_ENDPOINT),
  apiServerUrl: z.string().default(DEFAULT_API_SERVER_URL),
  subclientType: z.string().default(DEFAULT_SUBCLIENT_TYPE),
  ideName: z.string().default(DEFAULT_IDE_NAME),
})

/**
 * Fully resolved configuration with all defaults populated.
 */
export interface ResolvedGeminiConfig {
  /** Resolved Cloud Code PA base endpoint. */
  readonly cloudCodeEndpoint: string
  /** Resolved Gemini API server base URL. */
  readonly apiServerUrl: string
  /** Resolved subclient type identifier. */
  readonly subclientType: string
  /** Resolved client IDE identifier. */
  readonly ideName: string
}

/**
 * Resolves a partial Gemini configuration against canonical defaults.
 * @param config - User-provided or partial configuration object.
 * @returns Fully resolved configuration facts with defaults applied.
 */
export function resolveGeminiConfig(config?: Partial<GeminiConfig>): ResolvedGeminiConfig {
  const schemaResolved = Config(config ?? {})
  return {
    cloudCodeEndpoint: schemaResolved.cloudCodeEndpoint ?? DEFAULT_CLOUD_CODE_ENDPOINT,
    apiServerUrl: schemaResolved.apiServerUrl ?? DEFAULT_API_SERVER_URL,
    subclientType: schemaResolved.subclientType ?? DEFAULT_SUBCLIENT_TYPE,
    ideName: schemaResolved.ideName ?? DEFAULT_IDE_NAME,
  }
}
