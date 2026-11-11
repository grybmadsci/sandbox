import { create } from 'zustand'
import type { Inspection } from '../sim/inspect'
import { tools, type Tool } from './tools'

export const MIN_BRUSH = 1
export const MAX_BRUSH = 40

/** What the HUD shows about the world: each chunk's ChunkState, row by row, the camera's chunk, what it sees (cells: min x, min y, max x, max y), the biome at the camera, how many chunks are live, on the GPU and kept on the CPU, and bodies put away. */
export type WorldInfo = {
  seed: number
  states: Uint8Array
  camera: [number, number]
  view: [number, number, number, number]
  biome: string
  live: number
  loaded: number
  stored: number
  dormant: number
}

/** How far getting the world ready has got: loading the chunks around the camera, then settling a new world (ChunkManager.loading). */
export type Loading = { phase: 'loading' | 'settling'; done: number; total: number }

/** Saving and loading, wired up by the world once it's ready. */
export type Persistence = {
  quickSave: () => void
  quickLoad: () => void
  exportFile: () => void
  importFile: (file: File) => void
}

type SandboxState = {
  tool: Tool
  brushSize: number
  paused: boolean
  pressureView: boolean
  /** Bumped to ask the simulation to regenerate the level / clear the grid. */
  resetCount: number
  clearCount: number
  error: string | null
  /** The inspect tool's readout for the cell under the cursor. */
  inspection: Inspection | null
  world: WorldInfo | null
  /** While the world is loading (from the start, and after a reset or load), and how far it has got. */
  loading: Loading | null
  persistence: Persistence | null
  /** A short message for the player (saved, couldn't load...), shown for NOTICE_MS. */
  notice: string | null
  select: (tool: Tool) => void
  resizeBrush: (delta: number) => void
  togglePause: () => void
  togglePressureView: () => void
  reset: () => void
  clear: () => void
  fail: (error: string) => void
  inspect: (inspection: Inspection | null) => void
  showWorld: (world: WorldInfo) => void
  showLoading: (loading: Loading | null) => void
  notify: (text: string) => void
}

const NOTICE_MS = 6000
let noticeTimer: ReturnType<typeof setTimeout> | undefined

export const useSandbox = create<SandboxState>((set) => ({
  tool: tools[0],
  brushSize: 6,
  paused: false,
  pressureView: false,
  resetCount: 0,
  clearCount: 0,
  error: null,
  inspection: null,
  world: null,
  loading: { phase: 'loading', done: 0, total: 0 },
  persistence: null,
  notice: null,
  select: (tool) => set({ tool }),
  resizeBrush: (delta) =>
    set((s) => ({ brushSize: Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, s.brushSize + delta)) })),
  togglePause: () => set((s) => ({ paused: !s.paused })),
  togglePressureView: () => set((s) => ({ pressureView: !s.pressureView })),
  reset: () => set((s) => ({ resetCount: s.resetCount + 1 })),
  clear: () => set((s) => ({ clearCount: s.clearCount + 1 })),
  fail: (error) => set({ error }),
  inspect: (inspection) => set({ inspection }),
  showWorld: (world) => set({ world }),
  showLoading: (loading) => set({ loading }),
  notify: (text) => {
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS)
    set({ notice: text })
  },
}))
