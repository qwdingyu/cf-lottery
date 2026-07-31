/**
 * 系统配置页顶栏分区（方案 A：前端映射，不改 definitions.json 的 group 字段）。
 * group 字符串必须与 src/lib/system-config-definitions.json 完全一致。
 */
export type SystemConfigSectionId =
  | 'general'
  | 'payment'
  | 'security'
  | 'email'
  | 'referral'
  | 'ops'

export type SystemConfigSectionDef = {
  id: SystemConfigSectionId
  label: string
  /** 页头一句话说明 */
  description: string
  /** 有序 group 名；与 json `group` 完全一致 */
  groups: readonly string[]
  /** 是否展示危险「数据维护」清库区 */
  includeDangerZone?: boolean
}

export const SYSTEM_CONFIG_SECTIONS: readonly SystemConfigSectionDef[] = [
  {
    id: 'general',
    label: '通用',
    description: '用户端展示的品牌与客服联系方式。',
    groups: ['基础信息'],
  },
  {
    id: 'payment',
    label: '支付与余额',
    description:
      '余额/充值开关与金额区间、线下收款展示。余额与充值开关与「支付」页同源；在线支付渠道密钥请到支付页配置。',
    groups: ['支付配置'],
  },
  {
    id: 'security',
    label: '安全与风控',
    description: '人机验证、邮箱准入、下单/验证码限流与订单过期；影响前台风控与后台脱敏。',
    groups: ['安全与验证', '邮箱策略', '订单与限流', '后台与安全'],
  },
  {
    id: 'email',
    label: '邮件与通知',
    description: 'Resend 发信与库存预警；OTP/交付邮件依赖此处配置。',
    groups: ['邮件服务', '库存预警'],
  },
  {
    id: 'referral',
    label: '分销与返佣',
    description: '自动返佣总开关、全员推广码佣金模板；用户购后自动一码，前台 /refer 查看。',
    groups: ['分销与返佣'],
  },
  {
    id: 'ops',
    label: '数据与运维',
    description: '日志与限流等保留天数；下方为不可恢复的业务数据清理。',
    groups: ['数据保留与清理'],
    includeDangerZone: true,
  },
] as const

export const DEFAULT_SYSTEM_CONFIG_SECTION_ID: SystemConfigSectionId = 'general'

const sectionIdSet = new Set<string>(SYSTEM_CONFIG_SECTIONS.map((s) => s.id))

/** 非法或空 tab → 默认 general，禁止落到 ops */
export function resolveSystemConfigSectionId(raw: unknown): SystemConfigSectionId {
  if (typeof raw !== 'string') return DEFAULT_SYSTEM_CONFIG_SECTION_ID
  const id = raw.trim()
  if (sectionIdSet.has(id)) return id as SystemConfigSectionId
  return DEFAULT_SYSTEM_CONFIG_SECTION_ID
}

export function getSystemConfigSection(id: SystemConfigSectionId): SystemConfigSectionDef {
  const found = SYSTEM_CONFIG_SECTIONS.find((s) => s.id === id)
  return found ?? SYSTEM_CONFIG_SECTIONS[0]!
}

/** 映射中声明的全部 group（去重保序） */
export function listedSystemConfigGroups(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const section of SYSTEM_CONFIG_SECTIONS) {
    for (const group of section.groups) {
      if (seen.has(group)) continue
      seen.add(group)
      out.push(group)
    }
  }
  return out
}

export type DefinitionLike = { key: string; group?: string }

/**
 * 校验 section 映射与 definitions 是否一一覆盖。
 * 供 unit/contract 使用；UI 不调用。
 */
export function auditSystemConfigSectionCoverage(definitions: readonly DefinitionLike[]): {
  ok: boolean
  unmappedGroups: string[]
  unmappedKeys: string[]
  duplicateGroups: string[]
  extraGroupsInMap: string[]
  sectionKeyCounts: Record<string, number>
  totalKeys: number
} {
  const defGroups = new Set<string>()
  for (const d of definitions) {
    defGroups.add(d.group || '其他')
  }

  const groupToSection = new Map<string, SystemConfigSectionId>()
  const duplicateGroups: string[] = []
  for (const section of SYSTEM_CONFIG_SECTIONS) {
    for (const group of section.groups) {
      if (groupToSection.has(group)) {
        duplicateGroups.push(group)
        continue
      }
      groupToSection.set(group, section.id)
    }
  }

  const unmappedGroups = [...defGroups].filter((g) => !groupToSection.has(g)).sort()
  const extraGroupsInMap = [...groupToSection.keys()].filter((g) => !defGroups.has(g)).sort()

  const unmappedKeys: string[] = []
  const sectionKeyCounts: Record<string, number> = {}
  for (const section of SYSTEM_CONFIG_SECTIONS) {
    sectionKeyCounts[section.id] = 0
  }
  for (const d of definitions) {
    const g = d.group || '其他'
    const sectionId = groupToSection.get(g)
    if (!sectionId) {
      unmappedKeys.push(d.key)
      continue
    }
    sectionKeyCounts[sectionId] = (sectionKeyCounts[sectionId] ?? 0) + 1
  }

  return {
    ok:
      unmappedGroups.length === 0
      && unmappedKeys.length === 0
      && duplicateGroups.length === 0
      && extraGroupsInMap.length === 0,
    unmappedGroups,
    unmappedKeys,
    duplicateGroups,
    extraGroupsInMap,
    sectionKeyCounts,
    totalKeys: definitions.length,
  }
}
