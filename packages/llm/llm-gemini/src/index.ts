/**
 * Google Gemini subscription and Cloud Code PA LLM provider for DeepSeek Harness.
 * @module @deepseek-ai/dsh-llm-gemini
 */

/** Canonical plugin name for the Google Gemini LLM provider. */
export const name = 'llm-gemini'

export * from './config.ts'
export * from './oauth.ts'
export * from './cloud-code-client.ts'
export * from './stream.ts'
export * from './error.ts'
export * from './adapter.ts'
export type * from './types.ts'
