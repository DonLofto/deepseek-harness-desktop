/**
 * Well-known binary power-of-two token capacities mapped to standard labels.
 */
const BINARY_CAPACITIES = new Map<number, string>([
  [4096, '4K'],
  [8192, '8K'],
  [16384, '16K'],
  [32768, '32K'],
  [65536, '64K'],
  [131072, '128K'],
  [262144, '256K'],
  [524288, '512K'],
  [1048576, '1M'],
  [2097152, '2M'],
  [4194304, '4M'],
])

/**
 * Format a token capacity number (e.g. 1048576, 200000, 131072) into a concise display label (e.g. "1M", "200K", "128K").
 * @param tokens - integer token count.
 * @returns formatted string or empty string if invalid.
 */
export function formatTokenCapacity(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isInteger(tokens) || tokens <= 0) return ''
  const known = BINARY_CAPACITIES.get(tokens)
  if (known !== undefined) return known
  if (tokens % 1_000_000 === 0) return `${String(tokens / 1_000_000)}M`
  if (tokens % 1_000 === 0) return `${String(tokens / 1_000)}K`
  if (tokens % 1024 === 0) return `${String(tokens / 1024)}K`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${String(Math.round(tokens / 1_000))}K`
  return String(tokens)
}
