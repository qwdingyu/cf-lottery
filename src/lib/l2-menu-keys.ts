/**
 * L2 租户后台菜单目录常量（docs/255 L3 控制 L2 菜单）。
 *
 * 前后端共用同一份 key（前端 admin/lottery/menu-keys.ts 镜像本文件，测试锁定三方一致）。
 * 变更菜单名/路由时同步更新：① 本文件 ② 前端镜像 ③ AdminLayout.menuItems ④ 路由表。
 */
import { eq } from "drizzle-orm";
import type { DbType } from "../db/client";
import { systemConfig } from "../db/schema";

/** L2 菜单 key → 中文标签（展示给 L3 运营者勾选） */
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
const l2MenuKeySet = new Set<string>(L2_MENU_KEYS);

/** 菜单 key 白名单校验：未知 key 一律拒绝（防前后端命名漂移 + 防手写脏数据） */
export function isL2MenuKey(value: string): boolean {
  return l2MenuKeySet.has(value);
}

/**
 * L2 后台 API 路径 → 菜单 key 映射（后端强制 403 用）。
 * 只覆盖「有独立菜单页」的路径前缀；/me、/dashboard 等基础设施路径不映射。
 * 前缀按「最长匹配」命中：路径以 /{prefix} 开头（含子路径）。
 */
const MENU_PATH_PREFIXES: Array<{ prefix: string; menuKey: string }> = [
  { prefix: "/draws", menuKey: "AdminLottery" },
  // 活动模板列表（前端 AdminLotteryView 调用，docs/258 复核补漏映射）
  { prefix: "/templates", menuKey: "AdminLottery" },
  { prefix: "/prizes", menuKey: "AdminPrizes" },
  // 优惠券码池管理（i18n 引导「奖品管理 → 优惠券」导入，docs/258 复核补漏映射）
  { prefix: "/coupons", menuKey: "AdminPrizes" },
  { prefix: "/brand", menuKey: "AdminBrand" },
  { prefix: "/payment-config", menuKey: "AdminPaymentConfig" },
  { prefix: "/payment-orders", menuKey: "AdminPaymentOrders" },
  { prefix: "/quota-redeem", menuKey: "AdminQuotaRedeem" },
  { prefix: "/redemption-codes", menuKey: "AdminQuotaRedeem" },
  // 兑换记录（前端 AdminQuotaRedeemView 调用，docs/258 复核补漏映射）
  { prefix: "/redemption-records", menuKey: "AdminQuotaRedeem" },
  { prefix: "/integrations", menuKey: "AdminIntegrations" },
  { prefix: "/webhooks", menuKey: "AdminIntegrations" },
  { prefix: "/api-keys", menuKey: "AdminIntegrations" },
  // webhook 投递记录（docs/258 复核补漏映射）
  { prefix: "/webhook-deliveries", menuKey: "AdminIntegrations" },
  { prefix: "/platform-targets", menuKey: "AdminPlatformTarget" },
  { prefix: "/members", menuKey: "AdminMembers" },
  { prefix: "/blacklist", menuKey: "AdminBlacklist" },
  { prefix: "/logs", menuKey: "AdminLogs" },
];

/** 根据 L2 API 完整路径解析所属菜单 key；无映射（基础设施路径）返回 null */
export function resolveL2MenuKeyByPath(path: string): string | null {
  // 剥离 /api/admin 前缀：中间件收到的 c.req.url 是完整挂载路径（/api/admin/payment-config），
  // 而映射表前缀以子路径（/payment-config）定义，必须先去前缀再匹配。
  const subPath = path.startsWith("/api/admin") ? path.slice("/api/admin".length) : path;
  // 按前缀长度降序，保证 /payment-config 优先于 /payment-orders 等相似前缀
  const sorted = [...MENU_PATH_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { prefix, menuKey } of sorted) {
    if (subPath === prefix || subPath.startsWith(`${prefix}/`)) return menuKey;
  }
  return null;
}

/** disabled_l2_menus 配置的存储 key（不注册进 system-config-definitions，避免通用配置页出现第二个入口） */
export const DISABLED_L2_MENUS_KEY = "disabled_l2_menus";

/**
 * 解析 disabled_l2_menus 存储值（容忍空/非法 JSON，fail-safe 返回空数组）。
 * 非法 key 一律过滤（代码常量白名单，防手写脏数据/命名漂移）。
 */
export function parseDisabledL2Menus(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && isL2MenuKey(item));
  } catch {
    return [];
  }
}

/**
 * 读取当前禁用的 L2 菜单（L3 平台后台与 L2 中间件共用同一读取函数，保证两侧一致）。
 * 每请求一次主键查询；L2 后台低频，成本可接受（docs/026 §5.2），不加入公开参与链路。
 */
export async function readDisabledL2Menus(db: DbType): Promise<string[]> {
  const [row] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, DISABLED_L2_MENUS_KEY))
    .limit(1);
  return parseDisabledL2Menus(row?.value);
}
