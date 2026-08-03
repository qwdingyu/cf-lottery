/**
 * 管理端活动二维码 + 海报生成
 *
 * 从 AdminLotteryView 抽出：本地 QR（qrcode）+ html-to-image 海报截图，
 * 带内存缓存，避免 Free 方案下重复算力/远程依赖。
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toPng } from 'html-to-image'
import QRCode from 'qrcode'
import { formatDate } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import { useToast } from '@/composables/useToast'
import type { LotteryDraw } from './types'

const POSTER_CACHE_LIMIT = 30

export function usePosterQr() {
  const { t } = useI18n()
  const { showToast } = useToast()

  const showQrModal = ref(false)
  const qrImageUrl = ref('')
  const qrDrawUrl = ref('')
  const showPosterModal = ref(false)
  const posterGenerating = ref(false)
  const posterDomRef = ref<HTMLDivElement | null>(null)
  const posterDataUrl = ref('')
  const posterQrImageUrl = ref('')
  const posterDrawData = ref<LotteryDraw | null>(null)

  /** drawId → 公开链接（列表加载时可预填） */
  const qrUrlMap = new Map<string, { url: string; qrImageUrl: string }>()
  const qrDataUrlCache = new Map<string, string>()
  const posterCache = new Map<string, string>()

  const posterPlatformName = computed(() => t('lottery.adminPosterBrand'))
  const posterKindLabel = computed(() => {
    const map: Record<string, string> = {
      lottery: t('lottery.adminKindLottery'),
      signup_chain: t('lottery.adminKindSignupChain'),
      claim: t('lottery.adminKindClaim'),
      survey: t('lottery.adminKindSurvey'),
      vote: t('lottery.adminKindVote'),
      checkin: t('lottery.adminKindCheckin'),
      approval: t('lottery.adminKindApproval'),
      reservation: t('lottery.adminKindReservation'),
    }
    return map[(posterDrawData.value as any)?.activityKind || 'lottery'] || t('lottery.adminActivity')
  })
  const posterPrizeList = computed(() => {
    const tiers = (posterDrawData.value as any)?.tiers
    if (Array.isArray(tiers)) {
      return tiers.map((row: any) => row.prizeName || row.tierName).filter(Boolean)
    }
    return [] as string[]
  })
  const posterTimeText = computed(() => {
    const start = (posterDrawData.value as any)?.startAt || (posterDrawData.value as any)?.startTime
    const end = (posterDrawData.value as any)?.endAt || (posterDrawData.value as any)?.endTime
    if (start && end) return `${formatDate(start)} ~ ${formatDate(end)}`
    return ''
  })

  /**
   * 本地生成二维码 dataURL（惰性 + 缓存）。
   * 为什么本地：远程 qrserver 有第三方/CORS/隐私风险，html-to-image 也会污染画布。
   */
  async function generateQrDataUrl(url: string): Promise<string> {
    const cached = qrDataUrlCache.get(url)
    if (cached) return cached
    const dataUrl = await QRCode.toDataURL(url, {
      width: 300,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
    qrDataUrlCache.set(url, dataUrl)
    return dataUrl
  }

  function ensurePublicUrl(draw: LotteryDraw): string {
    const existing = qrUrlMap.get(draw.id)
    if (existing?.url) return existing.url
    const url = `${window.location.origin}/lottery/${draw.publicSlug}`
    qrUrlMap.set(draw.id, { url, qrImageUrl: '' })
    return url
  }

  /** 列表加载时预填公开链接，打开弹窗少一次拼接 */
  function prefetchPublicUrl(draw: LotteryDraw) {
    if (!draw.publicSlug) return
    if (!qrUrlMap.has(draw.id)) {
      qrUrlMap.set(draw.id, {
        url: `${typeof window !== 'undefined' ? window.location.origin : ''}/lottery/${draw.publicSlug}`,
        qrImageUrl: '',
      })
    }
  }

  async function handleShowQrCode(draw: LotteryDraw) {
    const url = ensurePublicUrl(draw)
    qrDrawUrl.value = url
    qrImageUrl.value = await generateQrDataUrl(url)
    showQrModal.value = true
  }

  function handleDownloadQr() {
    const a = document.createElement('a')
    a.href = qrImageUrl.value
    a.download = 'qrcode.png'
    a.click()
  }

  function handleCopyQrLink() {
    void writeClipboardText(qrDrawUrl.value)
    showToast(t('lottery.adminQrLinkCopied'), 'success')
  }

  async function generatePosterFromDom() {
    const node = posterDomRef.value
    if (!node) return
    try {
      posterDataUrl.value = await toPng(node, {
        pixelRatio: 2,
        cacheBust: true,
      })
    } catch (err) {
      console.warn('[poster] html-to-image failed:', err)
      posterDataUrl.value = ''
    }
  }

  async function handleShowPoster(draw: LotteryDraw) {
    posterDrawData.value = draw
    const url = ensurePublicUrl(draw)
    qrDrawUrl.value = url
    posterQrImageUrl.value = await generateQrDataUrl(url)
    showPosterModal.value = true
    const cached = posterCache.get(draw.id)
    if (cached) {
      posterDataUrl.value = cached
      return
    }
    posterGenerating.value = true
    await nextTick()
    await generatePosterFromDom()
    if (posterDataUrl.value) {
      if (posterCache.size >= POSTER_CACHE_LIMIT) {
        const oldestKey = posterCache.keys().next().value
        if (oldestKey !== undefined) posterCache.delete(oldestKey)
      }
      posterCache.set(draw.id, posterDataUrl.value)
    }
    posterGenerating.value = false
  }

  async function handleDownloadPoster() {
    if (!posterDataUrl.value) {
      showToast(t('lottery.adminPosterNotReady'), 'error')
      return
    }
    const a = document.createElement('a')
    a.href = posterDataUrl.value
    a.download = 'poster.png'
    a.click()
    showToast(t('lottery.adminPosterDownloaded'), 'success')
  }

  return {
    showQrModal,
    qrImageUrl,
    qrDrawUrl,
    showPosterModal,
    posterGenerating,
    posterDomRef,
    posterDataUrl,
    posterQrImageUrl,
    posterDrawData,
    posterPlatformName,
    posterKindLabel,
    posterPrizeList,
    posterTimeText,
    qrUrlMap,
    prefetchPublicUrl,
    handleShowQrCode,
    handleDownloadQr,
    handleCopyQrLink,
    handleShowPoster,
    handleDownloadPoster,
  }
}
