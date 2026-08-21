/**
 * ui-update plugin halves: the browser entry's dictionary and footer-slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal and bridge-subscription disposal — HMR safety), the bridge-absent
 * no-op, the inert node entry, and the invariant companion's reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as UpdateInvariant from '../src/invariant.ts'
import { en, zh } from '../src/client/locales.ts'

/** Slot ledger reader: entry ids currently registered in the footer list. */
function footerActionIds(ctx: Context): (string | undefined)[] {
  return ctx.slots.entries('sidebar.footer.action').map(entry => entry.options.id)
}

/** Boot the browser half over a real slot tree, with an optional desktop bridge. */
async function bench(options: { withBridge: boolean }) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

  const getStatus = vi.fn(() => Promise.resolve({ phase: 'idle' }))
  const unsubscribe = vi.fn()
  const onStatus = vi.fn(() => unsubscribe)
  const install = vi.fn(() => Promise.resolve())
  if (options.withBridge) {
    ;(globalThis as Record<string, unknown>).window = {
      dshDesktop: { updates: { getStatus, onStatus, check: vi.fn(), install } },
    }
  }
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, getStatus, onStatus, unsubscribe, install }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('ui-update browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers nothing when the desktop bridge is absent', async () => {
    const { ctx } = await bench({ withBridge: false })
    expect(footerActionIds(ctx)).toEqual([])
  })

  it('registers the footer action and tears it down with the fiber (HMR safety)', async () => {
    const { ctx, fiber, unsubscribe } = await bench({ withBridge: true })
    expect(footerActionIds(ctx)).toContain('update')
    await fiber.dispose()
    expect(footerActionIds(ctx)).not.toContain('update')
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('seeds the status source from the bridge on start', async () => {
    const { getStatus, onStatus } = await bench({ withBridge: true })
    expect(getStatus).toHaveBeenCalled()
    expect(onStatus).toHaveBeenCalled()
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench({ withBridge: true })
    const translate = ctx.locale.bind('update')
    expect(translate('available')).toBe(zh.available)
    ctx.locale.setLocale('en')
    expect(translate('available')).toBe(en.available)

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('available')).not.toBe(en.available)
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('provides the update slot face and forwards install to the bridge', async () => {
    const { ctx, install } = await bench({ withBridge: true })
    const entry = ctx.slots.entries('sidebar.footer.action').find(e => e.options.id === 'update')
    expect(entry).toBeDefined()
    const injectFn = entry?.inject as (() => { hooks: { status: unknown }; onInstall: () => void }) | undefined
    const face = injectFn?.()
    expect(face).toBeDefined()
    expect(face?.hooks.status).toBeDefined()
    face?.onInstall()
    expect(install).toHaveBeenCalled()
  })

  it('returns null when window exists but dshDesktop or updates is absent', async () => {
    ;(globalThis as Record<string, unknown>).window = {}
    const { readUpdateBridge } = await import('../src/client/desktop-bridge.ts')
    expect(readUpdateBridge()).toBeNull()
    ;(globalThis as Record<string, unknown>).window = { dshDesktop: {} }
    expect(readUpdateBridge()).toBeNull()
  })

  it('manages status source lifecycle, subscription, deduplication, and equality branches', async () => {
    const { createUpdateStatusSource } = await import('../src/client/status-source.ts')
    type UpdateStatus = import('../src/client/desktop-bridge.ts').UpdateStatus
    let pushStatus!: (status: UpdateStatus) => void
    const bridge = {
      getStatus: vi.fn(() => Promise.resolve<UpdateStatus>({ phase: 'checking' })),
      onStatus: vi.fn((cb: (s: UpdateStatus) => void) => {
        pushStatus = cb
        return vi.fn()
      }),
      check: vi.fn(() => Promise.resolve()),
      install: vi.fn(() => Promise.resolve()),
    }
    const source = createUpdateStatusSource(bridge)
    expect(source.getSnapshot()).toEqual({ phase: 'idle' })

    const listener = vi.fn()
    const unsub = source.subscribe(listener)
    source.start()
    expect(bridge.onStatus).toHaveBeenCalled()

    // Wait for getStatus promise
    await Promise.resolve()
    expect(source.getSnapshot()).toEqual({ phase: 'checking' })
    expect(listener).toHaveBeenCalled()

    // Deduplication (same status)
    listener.mockClear()
    pushStatus({ phase: 'checking' })
    expect(listener).not.toHaveBeenCalled()

    // Phase change
    pushStatus({ phase: 'available', version: '1.0.0' })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Same available
    pushStatus({ phase: 'available', version: '1.0.0' })
    expect(listener).not.toHaveBeenCalled()

    // Different version available
    pushStatus({ phase: 'available', version: '1.0.1' })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Downloading
    pushStatus({ phase: 'downloading', version: '1.0.1', percent: 50 })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Same downloading
    pushStatus({ phase: 'downloading', version: '1.0.1', percent: 50 })
    expect(listener).not.toHaveBeenCalled()

    // Downloading different percent
    pushStatus({ phase: 'downloading', version: '1.0.1', percent: 75 })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Downloading different version
    pushStatus({ phase: 'downloading', version: '1.0.2', percent: 75 })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Downloaded
    pushStatus({ phase: 'downloaded', version: '1.0.2' })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Downloaded same
    pushStatus({ phase: 'downloaded', version: '1.0.2' })
    expect(listener).not.toHaveBeenCalled()

    // Downloaded different version
    pushStatus({ phase: 'downloaded', version: '1.0.3' })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Error
    pushStatus({ phase: 'error', message: 'fail' })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Error same
    pushStatus({ phase: 'error', message: 'fail' })
    expect(listener).not.toHaveBeenCalled()

    // Error different message
    pushStatus({ phase: 'error', message: 'network error' })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Up to date
    pushStatus({ phase: 'up-to-date' })
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // Up to date same
    pushStatus({ phase: 'up-to-date' })
    expect(listener).not.toHaveBeenCalled()

    // Unsubscribe listener
    unsub()
    pushStatus({ phase: 'idle' })
    expect(listener).not.toHaveBeenCalled()

    // Dispose
    source.dispose()
  })
})

describe('ui-update node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('ui-update invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(UpdateInvariant)
    await fiber.await()
    expect(UpdateInvariant.name).toBe('client-ui-update-invariant')
    expect(UpdateInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
