import { create } from 'zustand'
import { palette, type MaterialKey } from '../sim/materials'

export const MIN_BRUSH = 1
export const MAX_BRUSH = 40

type SandboxState = {
  material: MaterialKey
  brushSize: number
  paused: boolean
  /** Bumped to ask the simulation to regenerate the level / clear the grid. */
  resetCount: number
  clearCount: number
  error: string | null
  select: (material: MaterialKey) => void
  resizeBrush: (delta: number) => void
  togglePause: () => void
  reset: () => void
  clear: () => void
  fail: (error: string) => void
}

export const useSandbox = create<SandboxState>((set) => ({
  material: palette[0],
  brushSize: 6,
  paused: false,
  resetCount: 0,
  clearCount: 0,
  error: null,
  select: (material) => set({ material }),
  resizeBrush: (delta) =>
    set((s) => ({ brushSize: Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, s.brushSize + delta)) })),
  togglePause: () => set((s) => ({ paused: !s.paused })),
  reset: () => set((s) => ({ resetCount: s.resetCount + 1 })),
  clear: () => set((s) => ({ clearCount: s.clearCount + 1 })),
  fail: (error) => set({ error }),
}))
