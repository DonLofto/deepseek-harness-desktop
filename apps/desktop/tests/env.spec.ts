import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDesktopEnv } from '../src/env.ts'

describe('resolveDesktopEnv', () => {
  const originalEnv = { ...process.env }
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `dsh-desktop-env-test-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('includes --no-open in the fallback dev launch args', () => {
    delete process.env.DSH_DESKTOP_DSH_BIN
    delete process.env.DSH_DESKTOP_PORT
    const env = resolveDesktopEnv(tempDir)
    expect(env.launch.command).toBe('node')
    expect(env.launch.args).toContain('web')
    expect(env.launch.args).toContain('--no-open')
    expect(env.launch.args).toContain('--port')
    expect(env.launch.args).toContain('0')
  })

  it('includes --no-open when DSH_DESKTOP_DSH_BIN is explicitly provided', () => {
    process.env.DSH_DESKTOP_DSH_BIN = '/custom/bin/dsh'
    process.env.DSH_DESKTOP_PORT = '8080'
    const env = resolveDesktopEnv(tempDir)
    expect(env.launch.command).toBe('/custom/bin/dsh')
    expect(env.launch.args).toEqual(['web', '--no-open', '--port', '8080'])
  })

  it('includes --no-open when bundled runtime and harness bin exist', () => {
    delete process.env.DSH_DESKTOP_DSH_BIN
    const nodeRel = process.platform === 'win32'
      ? join('runtime', `${process.platform}-${process.arch}`, 'node.exe')
      : join('runtime', `${process.platform}-${process.arch}`, 'bin', 'node')
    const nodePath = join(tempDir, nodeRel)
    const binPath = join(tempDir, 'harness', 'lib', 'bin.js')
    mkdirSync(join(tempDir, 'harness', 'lib'), { recursive: true })
    mkdirSync(join(nodePath, '..'), { recursive: true })
    writeFileSync(nodePath, '')
    writeFileSync(binPath, '')

    const env = resolveDesktopEnv(tempDir)
    expect(env.launch.command).toBe(nodePath)
    expect(env.launch.args).toEqual([binPath, 'web', '--no-open', '--port', '0'])
  })

  it('respects DSH_DESKTOP_LOG_DIR and DSH_DESKTOP_UPDATE_INTERVAL_MS', () => {
    process.env.DSH_DESKTOP_LOG_DIR = '/custom/logs'
    process.env.DSH_DESKTOP_UPDATE_INTERVAL_MS = '60000'
    const env = resolveDesktopEnv(tempDir)
    expect(env.logFile).toBe(join('/custom/logs', 'harness.log'))
    expect(env.updateCheckIntervalMs).toBe(60000)
  })
})
