import { describe, expect, it } from 'vitest'
import {
  normalizeWheelRotation,
  normalizeWheelSectorIndex,
  rotationDeltaForWheelSector,
} from './wheel-motion'

const FULL_TURN = Math.PI * 2
const POINTER_ANGLE = -Math.PI / 2

function sectorCenterAtPointer(
  sectorIndex: number,
  sectorCount: number,
  finalRotation: number,
): number {
  const index = normalizeWheelSectorIndex(sectorIndex, sectorCount)
  const slice = FULL_TURN / sectorCount
  return normalizeWheelRotation(index * slice + slice / 2 + finalRotation)
}

describe('wheel motion', () => {
  it('让任意真实奖项扇区中心精确对齐顶部指针', () => {
    for (const sectorCount of [1, 2, 3, 7, 12]) {
      for (let sectorIndex = 0; sectorIndex < sectorCount; sectorIndex++) {
        const startRotation = 1.234
        const delta = rotationDeltaForWheelSector(sectorIndex, sectorCount, startRotation, 5)
        expect(sectorCenterAtPointer(sectorIndex, sectorCount, startRotation + delta))
          .toBeCloseTo(normalizeWheelRotation(POINTER_ANGLE), 10)
      }
    }
  })

  it('归一化旧数据或异常结果中的负数和越界索引', () => {
    expect(normalizeWheelSectorIndex(-1, 6)).toBe(5)
    expect(normalizeWheelSectorIndex(8, 6)).toBe(2)
    expect(normalizeWheelSectorIndex(2.9, 6)).toBe(2)
  })

  it('结果动画至少包含规定的完整圈数', () => {
    const delta = rotationDeltaForWheelSector(2, 6, 0.4, 5)
    expect(delta).toBeGreaterThanOrEqual(FULL_TURN * 5)
  })
})
