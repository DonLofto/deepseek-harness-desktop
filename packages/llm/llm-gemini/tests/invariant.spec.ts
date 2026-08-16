import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import * as InvariantModule from '../src/invariant.ts'

describe('llm-gemini invariant companion', () => {
  it('registers invariant installer on invariants service', async () => {
    let capturedInstaller: InvariantInstaller | undefined
    const registerMock = vi.fn((_pkg: string, install: InvariantInstaller) => {
      capturedInstaller = install
      return () => {}
    })
    const ctx = {
      invariants: {
        register: registerMock,
      },
    } as unknown as Context

    const disposer = await InvariantModule.apply(ctx)
    expect(registerMock).toHaveBeenCalledWith('@deepseek-ai/dsh-llm-gemini', expect.any(Function))
    expect(typeof disposer).toBe('function')

    expect(capturedInstaller).toBeDefined()
    const fail: InvariantFailure = (msg: string): never => {
      throw new Error(msg)
    }
    await capturedInstaller?.(ctx, fail)
  })

  it('exposes expected plugin metadata', () => {
    expect(InvariantModule.name).toBe('llm-gemini-invariant')
    expect(InvariantModule.inject).toEqual(['invariants'])
  })
})
