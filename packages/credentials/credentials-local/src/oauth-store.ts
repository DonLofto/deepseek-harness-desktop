/**
 * File-backed OAuth credentials store over `$DSH_HOME/.credentials.oauth.json`,
 * implementing the CredentialStore interface used by pi-ai and provider auth.
 *
 * Enforces POSIX 0600 owner-only permissions and atomic writes with cross-process
 * file locks, preventing credential exposure or race conditions.
 *
 * @module @deepseek-ai/dsh-credentials-local/oauth-store
 */

import { stat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Basename of the OAuth credentials document inside the harness home. */
export const OAUTH_CREDENTIALS_FILENAME = '.credentials.oauth.json'

/** Permission bits outside the owner; an OAuth credentials document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/**
 * Reject a credentials document other OS users can read, before its contents
 * are read at all. The provider creates and replaces the file at `0600`.
 *
 * @param filename - absolute path of the document.
 * @throws when the file exists with group or other permission bits set on POSIX.
 */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (!isENOENT(error)) throw error
    await canonicalizeWatchPath(filename)
    return
  }
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer; native Windows coverage does. */
  if (process.platform === 'win32') return
  const offending = mode & GROUP_OTHER_BITS
  if (offending === 0) return
  throw new Error(
    `credentials-local: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
    + ` run "chmod 600 ${filename}" before starting again`,
  )
}

/** Whether a filesystem error means absence. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** One stored credential entry. */
export interface OAuthCredential {
  type: string
  key?: string | undefined
  token?: string | undefined
  refreshToken?: string | undefined
  expiresAt?: number | undefined
  accountId?: string | undefined
  email?: string | undefined
  [key: string]: unknown
}

/** Options for configuring the {@link OAuthFileCredentialStore}. */
export interface OAuthFileCredentialStoreOptions {
  /** Explicit absolute path to the credentials JSON file. */
  filename?: string | undefined
  /** Custom harness home directory; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string | undefined
}

/**
 * File-backed credential store conforming to pi-ai's `CredentialStore` interface.
 */
export class OAuthFileCredentialStore {
  /** Absolute path to the OAuth credentials backing file on disk. */
  readonly filename: string

  constructor(options: OAuthFileCredentialStoreOptions = {}) {
    this.filename = options.filename !== undefined
      ? resolve(options.filename)
      : resolve(join(resolveDshHome(options.dshHome), OAUTH_CREDENTIALS_FILENAME))
  }

  /**
   * Read all credentials from disk.
   * @returns Record of providerId to credential object.
   */
  private async readAll(): Promise<Record<string, OAuthCredential>> {
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return {}
      throw error
    }
    const trimmed = text.trim()
    if (trimmed.length === 0) return {}
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, OAuthCredential>
      }
      return {}
    } catch {
      return {}
    }
  }

  /**
   * Read one credential for a given provider.
   * @param providerId - provider identifier (e.g. 'openai-codex', 'google').
   * @returns the stored credential or undefined.
   */
  async read(providerId: string): Promise<OAuthCredential | undefined> {
    const all = await this.readAll()
    return all[providerId]
  }

  /**
   * Atomically mutate or store one provider credential under a file lock.
   * @param providerId - provider identifier.
   * @param fn - update function receiving current credential.
   * @returns the updated credential.
   */
  async modify(
    providerId: string,
    fn: (current: OAuthCredential | undefined) => Promise<OAuthCredential | undefined> | OAuthCredential | undefined,
  ): Promise<OAuthCredential | undefined> {
    return withFileLock(this.filename, async () => {
      const all = await this.readAll()
      const current = all[providerId]
      const next = await fn(current)
      if (next === undefined) {
        Reflect.deleteProperty(all, providerId)
      } else {
        all[providerId] = next
      }
      await writeFileAtomic(this.filename, JSON.stringify(all, null, 2), { mode: 0o600 })
      return next ?? current
    })
  }

  /**
   * Delete one provider credential under a file lock.
   * @param providerId - provider identifier to delete.
   */
  async delete(providerId: string): Promise<void> {
    await withFileLock(this.filename, async () => {
      const all = await this.readAll()
      if (all[providerId] === undefined) return
      Reflect.deleteProperty(all, providerId)
      await writeFileAtomic(this.filename, JSON.stringify(all, null, 2), { mode: 0o600 })
    })
  }

  /**
   * List all stored credentials.
   * @returns Array of provider IDs and their credential types.
   */
  async list(): Promise<Array<{ providerId: string; type: string }>> {
    const all = await this.readAll()
    return Object.entries(all).map(([providerId, credential]) => ({
      providerId,
      type: credential.type ?? 'oauth',
    }))
  }
}
