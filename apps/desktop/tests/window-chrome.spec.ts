import { describe, expect, it } from 'vitest'
import { shouldInstallWindowDragChrome } from '../src/window-chrome.ts'

describe('desktop window drag chrome', () => {
  it('installs the custom drag regions only on Windows', () => {
    expect(shouldInstallWindowDragChrome('win32')).toBe(true)
    expect(shouldInstallWindowDragChrome('darwin')).toBe(false)
    expect(shouldInstallWindowDragChrome('linux')).toBe(false)
  })
})
