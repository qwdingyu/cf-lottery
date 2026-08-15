const FULL_TURN = Math.PI * 2
const POINTER_ANGLE = -Math.PI / 2

/** 将任意整数索引归一化到当前扇区范围，避免旧结果或异常值落到错误扇区。 */
export function normalizeWheelSectorIndex(sectorIndex: number, sectorCount: number): number {
  const count = Math.max(Math.floor(sectorCount), 1)
  const index = Math.floor(sectorIndex)
  return ((index % count) + count) % count
}

/**
 * 返回从 startRotation 正向转动后停在指定扇区中心的角度。
 * 指针固定在正上方；服务端已决定的 prizeIndex 是唯一目标，前端只负责几何对齐。
 */
export function rotationDeltaForWheelSector(
  sectorIndex: number,
  sectorCount: number,
  startRotation: number,
  minimumFullTurns: number,
): number {
  const count = Math.max(Math.floor(sectorCount), 1)
  const index = normalizeWheelSectorIndex(sectorIndex, count)
  const slice = FULL_TURN / count
  const sectorCenter = index * slice + slice / 2
  const desiredRotation = POINTER_ANGLE - sectorCenter
  const minDistance = FULL_TURN * Math.max(Math.floor(minimumFullTurns), 0)
  let delta = desiredRotation - (startRotation % FULL_TURN)
  while (delta < minDistance) delta += FULL_TURN
  return delta
}

/** 供组件和测试统一比较最终角度，避免浮点累计导致的展示差异。 */
export function normalizeWheelRotation(rotation: number): number {
  const normalized = rotation % FULL_TURN
  return normalized < 0 ? normalized + FULL_TURN : normalized
}
