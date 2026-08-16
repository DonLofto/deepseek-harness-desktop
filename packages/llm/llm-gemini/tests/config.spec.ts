import { describe, it, expect } from 'vitest'
import {
  Config,
  DEFAULT_API_SERVER_URL,
  DEFAULT_CLOUD_CODE_ENDPOINT,
  DEFAULT_IDE_NAME,
  DEFAULT_SUBCLIENT_TYPE,
  resolveGeminiConfig,
} from '../src/config.ts'

describe('Gemini Config Schema', () => {
  it('supplies canonical defaults when empty', () => {
    const resolved = resolveGeminiConfig({})
    expect(resolved.cloudCodeEndpoint).toBe('https://daily-cloudcode-pa.googleapis.com')
    expect(resolved.apiServerUrl).toBe('https://generativelanguage.googleapis.com')
    expect(resolved.subclientType).toBe('hub')
    expect(resolved.ideName).toBe('antigravity')
  })

  it('supplies canonical defaults when config is undefined', () => {
    const resolved = resolveGeminiConfig()
    expect(resolved.cloudCodeEndpoint).toBe(DEFAULT_CLOUD_CODE_ENDPOINT)
    expect(resolved.apiServerUrl).toBe(DEFAULT_API_SERVER_URL)
    expect(resolved.subclientType).toBe(DEFAULT_SUBCLIENT_TYPE)
    expect(resolved.ideName).toBe(DEFAULT_IDE_NAME)
  })

  it('preserves user-specified overrides', () => {
    const custom = {
      cloudCodeEndpoint: 'https://custom-cloudcode.googleapis.com',
      apiServerUrl: 'https://custom-gemini.googleapis.com',
      subclientType: 'vscode',
      ideName: 'custom-ide',
    }
    const resolved = resolveGeminiConfig(custom)
    expect(resolved.cloudCodeEndpoint).toBe('https://custom-cloudcode.googleapis.com')
    expect(resolved.apiServerUrl).toBe('https://custom-gemini.googleapis.com')
    expect(resolved.subclientType).toBe('vscode')
    expect(resolved.ideName).toBe('custom-ide')
  })

  it('evaluates defaults with Schemastery Config schema', () => {
    const parsed = Config({})
    expect(parsed.cloudCodeEndpoint).toBe('https://daily-cloudcode-pa.googleapis.com')
    expect(parsed.apiServerUrl).toBe('https://generativelanguage.googleapis.com')
    expect(parsed.subclientType).toBe('hub')
    expect(parsed.ideName).toBe('antigravity')
  })
})
