/**
 * 管理端活动数据分析弹窗状态
 *
 * 漏斗卡片、转化率、外部回传列表与 CSV 导出。
 * 从 AdminLotteryView 抽出，避免与活动 CRUD 编排缠在一起。
 */
import { computed, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import type { DrawAnalyticsStats, ExternalConversion, LotteryDraw } from './types'
import { fetchDrawAnalyticsStats, fetchDrawConversions } from './api'
import { downloadCsv, percent } from './ops-utils'

export function useDrawAnalytics(opts: {
  /** 与列表操作互斥的 loading id */
  operatingId: Ref<string>
}) {
  const { t } = useI18n()
  const { showToast } = useToast()

  const showAnalyticsModal = ref(false)
  const analyticsLoading = ref(false)
  const analyticsError = ref('')
  const analyticsDraw = ref<LotteryDraw | null>(null)
  const analyticsStats = ref<DrawAnalyticsStats | null>(null)
  const analyticsConversions = ref<ExternalConversion[]>([])

  const analyticsFunnelCards = computed(() => {
    const stats = analyticsStats.value
    const events = stats?.events
    return [
      { key: 'page_view', label: t('lottery.adminFunnelViews'), value: events?.pageViews ?? 0 },
      { key: 'participation_started', label: t('lottery.adminFunnelStarted'), value: events?.totals.participation_started ?? 0 },
      { key: 'participation_completed', label: t('lottery.adminFunnelCompleted'), value: events?.participationCompleted ?? 0 },
      { key: 'cta_click', label: t('lottery.adminFunnelCta'), value: events?.ctaClicks ?? 0 },
      { key: 'share_click', label: t('lottery.adminFunnelShares'), value: events?.shareClicks ?? 0 },
      { key: 'attributed_join', label: t('lottery.adminFunnelJoins'), value: events?.attributedJoins ?? 0 },
      { key: 'external_conversion_reported', label: t('lottery.adminFunnelConversions'), value: events?.externalConversionsReported ?? 0 },
    ]
  })

  const conversionTypeRows = computed(() => {
    const totals = analyticsStats.value?.externalConversions?.totals || {}
    return Object.entries(totals)
      .map(([type, row]) => ({ type, count: Number(row.count || 0), amountCents: Number(row.amountCents || 0) }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  })

  const completionRate = computed(() => percent(
    analyticsStats.value?.events.participationCompleted || 0,
    analyticsStats.value?.events.pageViews || 0,
  ))
  const ctaRate = computed(() => percent(
    analyticsStats.value?.events.ctaClicks || 0,
    analyticsStats.value?.events.participationCompleted || 0,
  ))
  const externalConversionRate = computed(() => percent(
    analyticsStats.value?.externalConversions.totalCount || 0,
    analyticsStats.value?.events.ctaClicks || 0,
  ))

  function conversionTypeLabel(type: string): string {
    const map: Record<string, string> = {
      registration: t('lottery.adminConvReg'),
      purchase: t('lottery.adminConvPurchase'),
      coupon_redeemed: t('lottery.adminConvCouponRedeemed'),
      lead_qualified: t('lottery.adminConvLead'),
      offline_redeemed: t('lottery.adminConvOffline'),
      custom: t('lottery.adminConvCustom'),
    }
    return map[type] || type || '-'
  }

  async function handleViewAnalytics(draw: LotteryDraw) {
    analyticsDraw.value = draw
    showAnalyticsModal.value = true
    analyticsLoading.value = true
    analyticsError.value = ''
    analyticsStats.value = null
    analyticsConversions.value = []
    opts.operatingId.value = draw.id
    try {
      const [stats, conversionData] = await Promise.all([
        fetchDrawAnalyticsStats(draw.id),
        fetchDrawConversions(draw.id),
      ])
      analyticsStats.value = {
        ...stats,
        externalConversions: conversionData.summary || stats.externalConversions,
      }
      analyticsConversions.value = conversionData.conversions || []
    } catch (e: any) {
      analyticsError.value = e?.message || t('lottery.adminAnalyticsLoadFailed')
      showToast(analyticsError.value, 'error')
    } finally {
      analyticsLoading.value = false
      opts.operatingId.value = ''
    }
  }

  function handleExportConversions() {
    if (analyticsConversions.value.length === 0) return
    const rows = [
      [t('lottery.adminConvType'), t('lottery.adminConvSource'), t('lottery.adminConvEvent'), t('lottery.adminCsvIdentityType'), t('lottery.adminCsvIdentityValue'), 'ref', t('lottery.adminCsvAmountCents'), t('lottery.adminCsvCurrency'), t('lottery.adminConvOccurredAt'), t('lottery.adminCsvReportedAt')],
      ...analyticsConversions.value.map((item) => [
        conversionTypeLabel(item.conversionType),
        item.source || '',
        item.externalEventId,
        item.identityType || '',
        item.identityValue || '',
        item.refCode || '',
        item.amountCents === null || item.amountCents === undefined ? '' : String(item.amountCents),
        item.currency || '',
        item.occurredAt || '',
        item.createdAt || '',
      ]),
    ]
    const idPart = (analyticsDraw.value?.id || 'conversions').slice(0, 40)
    downloadCsv(`activity-conversions-${idPart}-${new Date().toISOString().slice(0, 10)}.csv`, rows)
    showToast(t('lottery.adminConversionsExported'), 'success')
  }

  return {
    showAnalyticsModal,
    analyticsLoading,
    analyticsError,
    analyticsDraw,
    analyticsStats,
    analyticsConversions,
    analyticsFunnelCards,
    conversionTypeRows,
    completionRate,
    ctaRate,
    externalConversionRate,
    conversionTypeLabel,
    handleViewAnalytics,
    handleExportConversions,
  }
}
