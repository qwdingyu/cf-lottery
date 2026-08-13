/**
 * 平台公共日期工具（src/lib = 跨领域共享层）。
 *
 * todayStr 原来是 checkin-reward（services/platform/）的私有函数，
 * 后被 lottery/每日免费（services/lottery/）、用量快照（services/admin/）跨领域引用，
 * 为避免核心领域反向依赖 platform 领域，统一收敛到 lib。
 */

/** 计算「今天」的 YYYY-MM-DD（本地时区，非 UTC） */
export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}