/**
 * 系统配置页顶栏分区（cf-lottery 精简版）。
 * group 字符串必须与 system-config-definitions.json 完全一致。
 */
export type SystemConfigSectionId =
  | 'general'
  | 'security'
  | 'ops'

export type SystemConfigSectionDef = {
  id: SystemConfigSectionId
  label: string
  description: string
  groups: readonly string[]
  includeDangerZone?: boolean
}

export const SYSTEM_CONFIG_SECTIONS: readonly SystemConfigSectionDef[] = [
  {
    id: 'general',
    label: '通用',
    description: '平台品牌信息与基本设置。',
    groups: ['基础信息'],
  },
  {
    id: 'security',
    label: '安全设置',
    description: '验证码有效期、频率限制等安全参数。',
    groups: ['安全设置'],
  },
  {
    id: 'ops',
    label: '数据维护',
    description: '数据保留天数等运维参数。',
    groups: ['数据维护'],
  },
] as const

export const DEFAULT_SYSTEM_CONFIG_SECTION_ID: SystemConfigSectionId = 'general'

const sectionIdSet = new Set<string>(SYSTEM_CONFIG_SECTIONS.map((s) => s.id))

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