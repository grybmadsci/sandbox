import { create } from 'zustand'
import { tools, type Tool } from './tools'

export const MIN_BRUSH = 1
export const MAX_BRUSH = 40

type SandboxState = {
  tool: Tool
  brushSize: number
  paused: boolean
  pressureView: boolean
  /** Bumped to ask the simulation to regenerate the level / clear the grid. */
  resetCount: number
  clearCount: number
  error: string | null
  select: (tool: Tool) => void
  resizeBrush: (delta: number) => void
  togglePause: () => void
  togglePressureView: () => void
  reset: () => void
  clear: () => void
  fail: (error: string) => void
}

export const useSandbox = create<SandboxState>((set) => ({
  tool: tools[0],
  brushSize: 6,
  paused: false,
  pressureView: false,
  resetCount: 0,
  clearCount: 0,
  error: null,
  select: (tool) => set({ tool }),
  resizeBrush: (delta) =>
    set((s) => ({ brushSize: Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, s.brushSize + delta)) })),
  togglePause: () => set((s) => ({ paused: !s.paused })),
  togglePressureView: () => set((s) => ({ pressureView: !s.pressureView })),
  reset: () => set((s) => ({ resetCount: s.resetCount + 1 })),
  clear: () => set((s) => ({ clearCount: s.clearCount + 1 })),
  fail: (error) => set({ error }),
}))
