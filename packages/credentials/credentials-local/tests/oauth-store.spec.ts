import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthFileCredentialStore, OAUTH_CREDENTIALS_FILENAME } from '../src/oauth-store.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-store-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('OAuthFileCredentialStore', () => {
  it('resolves default path under dshHome', async () => {
    const dir = await tempDir()
    const store = new OAuthFileCredentialStore({ dshHome: dir })
    expect(store.filename).toBe(join(dir, OAUTH_CREDENTIALS_FILENAME))
  })

  it('reads undefined when file is absent', async () => {
    const dir = await tempDir()
    const store = new OAuthFileCredentialStore({ dshHome: dir })
    const result = await store.read('openai-codex')
    expect(result).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('stores, reads, and lists credentials with 0600 file mode', async () => {
    const dir = await tempDir()
    const store = new OAuthFileCredentialStore({ dshHome: dir })

    await store.modify('openai-codex', () => ({
      type: 'oauth',
      token: 'test-token',
      refreshToken: 'test-refresh',
      expiresAt: 1234567890,
      accountId: 'test-account',
    }))

    const cred = await store.read('openai-codex')
    expect(cred).toEqual({
      type: 'oauth',
      token: 'test-token',
      refreshToken: 'test-refresh',
      expiresAt: 1234567890,
      accountId: 'test-account',
    })

    const list = await store.list()
    expect(list).toEqual([{ providerId: 'openai-codex', type: 'oauth' }])

    if (process.platform !== 'win32') {
      const mode = (await stat(store.filename)).mode
      expect(mode & 0o777).toBe(0o600)
    }
  })

  it('modifies and updates existing credentials', async () => {
    const dir = await tempDir()
    const store = new OAuthFileCredentialStore({ dshHome: dir })

    await store.modify('google', () => ({
      type: 'oauth',
      token: 'token-v1',
    }))

    await store.modify('google', current => ({
      ...current,
      type: 'oauth',
      token: 'token-v2',
    }))

    expect(await store.read('google')).toEqual({
      type: 'oauth',
      token: 'token-v2',
    })
  })

  it('deletes stored credential', async () => {
    const dir = await tempDir()
    const store = new OAuthFileCredentialStore({ dshHome: dir })

    await store.modify('openai-codex', () => ({
      type: 'oauth',
      token: 'to-delete',
    }))
    expect(await store.read('openai-codex')).toBeDefined()

    await store.delete('openai-codex')
    expect(await store.read('openai-codex')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('rejects readable file outside owner on POSIX', async () => {
    if (process.platform === 'win32') return
    const dir = await tempDir()
    const store = new OAuthFileCredentialStore({ dshHome: dir })

    await writeFile(store.filename, JSON.stringify({ 'openai-codex': { type: 'oauth' } }), { mode: 0o644 })
    await chmod(store.filename, 0o644)

    await expect(store.read('openai-codex')).rejects.toThrow(/readable beyond its owner/)
  })

  it('handles empty or corrupt JSON file gracefully', async () => {
    const dir = await tempDir()
    const store = new OAuthFileCredentialStore({ dshHome: dir })

    await writeFile(store.filename, '   ', { mode: 0o600 })
    expect(await store.read('openai-codex')).toBeUndefined()

    await writeFile(store.filename, 'invalid-json{{{', { mode: 0o600 })
    expect(await store.read('openai-codex')).toBeUndefined()
  })
})
