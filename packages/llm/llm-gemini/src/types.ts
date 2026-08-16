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
