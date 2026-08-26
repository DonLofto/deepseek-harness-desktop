/**
 * Persistent pinned/favorite models store backed by localStorage.
 */

const STORAGE_KEY = 'dsh.pinnedModels'

/**
 * Read the current set of pinned model keys ("provider/model").
 * @returns set of pinned model keys.
 */
export function loadPinnedModelKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === 'string'))
    }
  } catch {
    // Ignore storage parse errors
  }
  return new Set()
}

/**
 * Save the set of pinned model keys.
 * @param keys - set of pinned model keys.
 */
export function savePinnedModelKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]))
  } catch {
    // Ignore storage write errors
  }
}

/**
 * Toggle pin state for one model key ("provider/model").
 * @param key - model key ("provider/model").
 * @returns the updated set of pinned model keys.
 */
export function togglePinnedModelKey(key: string): Set<string> {
  const current = loadPinnedModelKeys()
  if (current.has(key)) {
    current.delete(key)
  } else {
    current.add(key)
  }
  savePinnedModelKeys(current)
  return current
}
