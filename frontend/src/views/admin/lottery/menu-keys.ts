/**
 * L2 租户后台菜单目录常量（前端镜像，与后端 src/lib/l2-menu-keys.ts 保持一致）。
 * 变更菜单时三方同步：后端 l2-menu-keys.ts / 本文件 / AdminLayout.menuItems。
 * 一致性由 menu-keys.test.ts 与后端目录比对锁定。
 */

export const L2_MENU_CATALOG: Array<{ key: string; label: string }> = [
  { key: "AdminDashboard", label: "运营台" },
  { key: "AdminLottery", label: "活动管理" },
  { key: "AdminPrizes", label: "奖品管理" },
  { key: "AdminBrand", label: "店铺设置" },
  { key: "AdminPaymentConfig", label: "支付配置" },
  { key: "AdminPaymentOrders", label: "支付订单" },
  { key: "AdminQuotaRedeem", label: "兑换额度" },
  { key: "AdminIntegrations", label: "集成设置" },
  { key: "AdminPlatformTarget", label: "平台助手" },
  { key: "AdminMembers", label: "团队成员" },
  { key: "AdminBlacklist", label: "黑名单" },
  { key: "AdminLogs", label: "操作日志" },
];

export const L2_MENU_KEYS = L2_MENU_CATALOG.map((item) => item.key);

/** 根据禁用列表过滤菜单目录（AdminLayout 与 L3 配置页共用同一过滤逻辑） */
export function filterL2MenusByDisabled(menuCatalog: Array<{ key: string; label: string }>, disabledMenus: string[]): Array<{ key: string; label: string }> {
  const disabled = new Set(disabledMenus)
  return menuCatalog.filter((item) => !disabled.has(item.key))
}
