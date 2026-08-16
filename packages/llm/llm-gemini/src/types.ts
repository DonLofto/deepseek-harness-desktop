/**
 * Data models and RPC shapes for Google Gemini subscription and Cloud Code PA.
 * @module @deepseek-ai/dsh-llm-gemini/types
 */

/**
 * Google Gemini user subscription tier entitlement details.
 */
export interface UserTier {
  /** Unique tier identifier, e.g. 'AGY_BUSINESS_PAYGO_TIER'. */
  id: string
  /** Human-readable tier display name, e.g. 'Gemini Business'. */
  name: string
  /** Description of the subscription tier and included features. */
  description?: string
  /** Whether this tier is the default tier for new users. */
  isDefault?: boolean
  /** User-configured companion Cloud project identifier. */
  userDefinedCloudaicompanionProject?: string
  /** Actionable URL for upgrading the current subscription tier. */
  upgradeSubscriptionUri?: string
  /** Upgrade subscription prompt text. */
  upgradeSubscriptionText?: string
  /** Button label for the upgrade prompt. */
  upgradeSubscriptionButtonText?: string
  /** Subscription billing/tier type identifier. */
  upgradeSubscriptionType?: string
  /** Number of available credits remaining for inference. */
  availableCredits?: number
  /** Client experience feature tag. */
  clientExperienceTag?: string
}

/**
 * Response payload returned by Cloud Code PA OnboardUser RPC.
 */
export interface OnboardUserResponse {
  /** Resolved subscription tier details. */
  userTier?: UserTier
  /** Active Google Cloud project ID. */
  project?: string
  /** Cloud Code location or region. */
  location?: string
  /** Associated Cloud AI companion project resource identifier. */
  cloudaicompanionProject?: string
}

/**
 * Summary of user quota status and remaining credits.
 */
export interface QuotaSummary {
  /** User tier identifier associated with this quota. */
  userTier: string
  /** Number of remaining inference credits, if applicable. */
  remainingCredits?: number
  /** Whether capacity or credits have been exhausted. */
  capacityExhausted?: boolean
}

/**
 * Individual model configuration and capability specification returned by Cloud Code PA.
 */
export interface ModelConfig {
  /** Unique model identifier, e.g. 'gemini-2.5-pro'. */
  id?: string
  /** Resource name or model path, e.g. 'models/gemini-2.5-pro'. */
  name?: string
  /** Human-readable model display label. */
  displayName?: string
  /** Description of model capabilities and recommended usage. */
  description?: string
  /** Supported generation methods, e.g. 'generateContent', 'streamGenerateContent'. */
  supportedGenerationMethods?: string[]
  /** Maximum input token context capacity. */
  inputTokenLimit?: number
  /** Maximum response token output limit. */
  outputTokenLimit?: number
  /** Whether the model is available or authorized for the active user tier. */
  isAvailable?: boolean
}

/**
 * Response payload returned by Cloud Code PA ListModelConfigs RPC.
 */
export interface ListModelConfigsResponse {
  /** List of model configurations authorized for the companion project or tier. */
  modelConfigs?: ModelConfig[]
  /** Alternative alias for model configuration list. */
  models?: ModelConfig[]
  /** Next page token for paginated model listings. */
  nextPageToken?: string
}
