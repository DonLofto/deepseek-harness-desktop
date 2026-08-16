import { describe, it, expect } from 'vitest'
import * as Index from '../src/index.ts'

describe('llm-gemini index entrypoint', () => {
  it('exports configuration schema, constants, and resolver', () => {
    expect(Index.DEFAULT_CLOUD_CODE_ENDPOINT).toBe('https://daily-cloudcode-pa.googleapis.com')
    expect(Index.DEFAULT_API_SERVER_URL).toBe('https://generativelanguage.googleapis.com')
    expect(Index.DEFAULT_SUBCLIENT_TYPE).toBe('hub')
    expect(Index.DEFAULT_IDE_NAME).toBe('antigravity')
    expect(typeof Index.resolveGeminiConfig).toBe('function')
    expect(typeof Index.Config).toBe('function')
  })
})
