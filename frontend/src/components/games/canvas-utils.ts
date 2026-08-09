/**
 * 画布 game 的高清适配工具（docs/162 P2-2）：
 * WheelGame 与 ScratchGame 使用 CSS 拉伸适配屏幕，但 bitmap 固定，
 * Retina 屏（devicePixelRatio ≥ 2）上文字和涂层明显模糊。
 *
 * 本模块提供：
 * - cappedDevicePixelRatio：返回 Math.min(devicePixelRatio, 2)，避免资源开销
 * - setupHiDPICanvas：根据逻辑尺寸设置 canvas.width/height 为 dpr 倍并 ctx.scale，
 *   此后全部绘制坐标用逻辑尺寸即可（clearRect 尺寸也按逻辑）。
 */

/**
 * 返回当前设备像素比，上限 2（dpr 3 的手机用 2 足够，避免 9× 像素成本）。
 * 纯函数，可单测。
 */
export function cappedDevicePixelRatio(win?: { devicePixelRatio?: number } | null): number {
  const raw = (win ?? (typeof window !== 'undefined' ? window : undefined))?.devicePixelRatio
  if (!raw || !Number.isFinite(raw) || raw < 1) return 1
  return Math.min(Math.max(raw, 1), 2)
}

/**
 * 设置 canvas 的实际 bitmap 尺寸并应用 ctx.scale，后续绘制使用逻辑坐标。
 * @param canvas 目标 canvas 元素
 * @param logicalW 逻辑宽度（CSS 空间，如 320）
 * @param logicalH 逻辑高度（CSS 空间，如 320）
 * @param dpr 设备像素比（通过 cappedDevicePixelRatio 获取）
 * @returns 已经 setTransform(dpr,0,0,dpr,0,0) 的 2d context
 */
export function setupHiDPICanvas(
  canvas: HTMLCanvasElement,
  logicalW: number,
  logicalH: number,
  dpr: number,
): CanvasRenderingContext2D {
  canvas.width = Math.round(logicalW * dpr)
  canvas.height = Math.round(logicalH * dpr)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}
