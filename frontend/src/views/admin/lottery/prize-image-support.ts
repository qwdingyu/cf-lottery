export type GamePrize = {
  id: string
  name: string
  imageUrl?: string | null
  value?: string | number
  type?: string
}

export function getPrizeDisplay(prize: GamePrize | undefined | null): string {
  if (!prize) return ''
  return prize.imageUrl || prize.name || '奖品'
}

export function getPrizeFallbackImage(prize: GamePrize | undefined | null): string {
  if (prize?.imageUrl) return prize.imageUrl
  if (prize?.name) {
    const char = prize.name.charAt(0).toUpperCase()
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#f59e0b"/><text x="16" y="20" text-anchor="middle" fill="#fff" font-size="12" font-family="sans-serif">${char}</text></svg>`)}`
  }
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#f59e0b"/><text x="16" y="20" text-anchor="middle" fill="#fff" font-size="12" font-family="sans-serif">?</text></svg>`)}`
}