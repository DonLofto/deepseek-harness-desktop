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

/**
 * Format model pricing (in USD per million tokens) into a concise display label (e.g. "Free", "$0.15/1M", "$3/1M").
 * @param pricing - optional pricing object with prompt and completion token cost per million tokens.
 * @returns formatted string or empty string if not available.
 */
export function formatModelPricing(pricing: { prompt?: number; completion?: number } | undefined): string {
  if (pricing === undefined) return ''
  const prompt = pricing.prompt ?? 0
  const completion = pricing.completion ?? 0
  if (prompt === 0 && completion === 0) return 'Free'
  const maxRate = Math.max(prompt, completion)
  if (maxRate < 0.01) return '<$0.01/1M'
  const formatted = maxRate >= 1
    ? (maxRate % 1 === 0 ? `$${String(maxRate)}/1M` : `$${maxRate.toFixed(2).replace(/\.?0+$/, '')}/1M`)
    : `$${maxRate.toFixed(2)}/1M`
  return formatted
}
