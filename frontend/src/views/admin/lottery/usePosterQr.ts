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
import { formatDateCST } from '@/composables/useFormat'
import { copyWithToast, useToast } from '@usethink/cf-admin-fe/composables'
import type { LotteryDraw } from './types'

/** 缓存上限常量 */
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

  const qrDataUrlCache = new Map<string, string>()
  const posterCache = new Map<string, string>()

  const _posterPlatformName = computed(() => t('lottery.adminPosterBrand'))
  const _posterKindLabel = computed(() => {
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
  const _posterPrizeList = computed(() => {
    const tiers = (posterDrawData.value as any)?.tiers
    if (Array.isArray(tiers)) {
      return tiers.map((row: any) => row.prizeName || row.tierName).filter(Boolean)
    }
    return [] as string[]
  })
  const posterTimeText = computed(() => {
    const start = (posterDrawData.value as any)?.startAt || (posterDrawData.value as any)?.startTime
    const end = (posterDrawData.value as any)?.endAt || (posterDrawData.value as any)?.endTime
    if (start && end) return `${formatDateCST(start)} ~ ${formatDateCST(end)}`
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
    // 优先用公开 slug；无 slug 时回退到 id（兼容旧数据）
    const slug = draw.publicSlug || draw.id
    const base = typeof window !== 'undefined' ? window.location.origin : ''
    return `${base}/#/d/${encodeURIComponent(slug)}`
  }

  // ---------- 二维码 ----------
  async function openQrModal(draw: LotteryDraw) {
    const publicUrl = ensurePublicUrl(draw)
    const dataUrl = await generateQrDataUrl(publicUrl)
    qrImageUrl.value = dataUrl
    qrDrawUrl.value = publicUrl
    showQrModal.value = true
  }

  async function handleCopyQrLink(drawOrEvent?: any) {
    // 若传入的是 LotteryDraw，用 ensurePublicUrl；否则用已存的 qrDrawUrl（弹窗内直接复制）
    const publicUrl = drawOrEvent && 'id' in drawOrEvent
      ? ensurePublicUrl(drawOrEvent)
      : qrDrawUrl.value
    if (!publicUrl) return
    await copyWithToast(publicUrl, {
      successMessage: t('lottery.adminCopyLinkSuccess'),
      errorMessage: t('lottery.adminCopyLinkFailed'),
    })
  }

  // ---------- 海报 ----------
  async function openPosterModal(draw: LotteryDraw) {
    posterGenerating.value = true
    showPosterModal.value = true
    posterDrawData.value = draw

    // 等 DOM 挂载后截图
    await nextTick()
    if (!posterDomRef.value) {
      posterGenerating.value = false
      return
    }

    try {
      // 内存缓存（30 张）
      const cacheKey = draw.id
      const cached = posterCache.get(cacheKey)
      if (cached) {
        posterDataUrl.value = cached
        posterQrImageUrl.value = await generateQrDataUrl(ensurePublicUrl(draw))
        posterGenerating.value = false
        return
      }

      // 先确保 QR 就绪
      const publicUrl = ensurePublicUrl(draw)
      const qrDataUrl = await generateQrDataUrl(publicUrl)
      posterQrImageUrl.value = qrDataUrl

      // 截图
      const dataUrl = await toPng(posterDomRef.value, {
        cacheBust: true,
        pixelRatio: 2,
      })

      posterCache.set(cacheKey, dataUrl)
      // 缓存上限：超出时清理最早的条目，防止内存无限增长
      if (posterCache.size > POSTER_CACHE_LIMIT) {
        const firstKey = posterCache.keys().next().value
        if (firstKey !== undefined) posterCache.delete(firstKey)
      }
      posterDataUrl.value = dataUrl
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : null) || t('lottery.adminPosterGenerateFailed'), 'error')
      console.error('[poster] generate failed:', err)
    } finally {
      posterGenerating.value = false
    }
  }

  async function downloadPoster(draw: LotteryDraw) {
    if (!posterDataUrl.value) return
    try {
      const link = document.createElement('a')
      link.download = `${draw.publicSlug || draw.id}-poster.png`
      link.href = posterDataUrl.value
      link.click()
      showToast(t('lottery.adminPosterDownloaded'), 'success')
    } catch {
      showToast(t('lottery.adminPosterDownloadFailed'), 'error')
    }
  }

  function prefetchPublicUrl(draw: LotteryDraw): string {
    return ensurePublicUrl(draw)
  }

  function handleShowQrCode(draw: LotteryDraw) {
    return openQrModal(draw)
  }

  /** 复制二维码链接（弹窗内直接复制当前 qrDrawUrl） */
  function handleDownloadQr() {
    return handleCopyQrLink()
  }

  function handleShowPoster(draw: LotteryDraw) {
    return openPosterModal(draw)
  }

  /** 下载海报（弹窗内直接使用 posterDrawData） */
  function handleDownloadPoster() {
    return downloadPoster(posterDrawData.value!)
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
    posterPlatformName: _posterPlatformName,
    posterKindLabel: _posterKindLabel,
    posterPrizeList: _posterPrizeList,
    posterTimeText,
    prefetchPublicUrl,
    handleShowQrCode,
    handleDownloadQr,
    handleCopyQrLink,
    handleShowPoster,
    handleDownloadPoster,
    openQrModal,
    openPosterModal,
    downloadPoster,
  }
}
