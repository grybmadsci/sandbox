import GenWorker from './genWorker?worker'
import type { WorldMode } from './worldgen'

/** A chunk to generate: all of it (to load), or only its tile of the overview. */
export type GenerateRequest = { id: number; seed: number; mode: WorldMode; cx: number; cy: number; kind: 'chunk' | 'tile' }
/** A generated chunk's state, its activity sums (chunkData.ts) and its tile; or only the tile. */
export type GenerateResult = { id: number; data?: Int32Array; sums?: Uint32Array; tile: Uint8Array }

/**
 * Generating a chunk takes several milliseconds (worldgen.ts), so it's done in a few
 * workers, one chunk each at a time: the caller asks for as many as are `available`, in
 * the order it wants them.
 */
export class ChunkGenerator {
  private readonly idle: Worker[] = []
  private readonly all: Worker[] = []
  private readonly waiting = new Map<number, (result: GenerateResult) => void>()
  private nextId = 0

  constructor(count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < count; i++) {
      const worker = new GenWorker({ name: location.search })
      worker.onmessage = ({ data }: MessageEvent<GenerateResult>) => {
        this.idle.push(worker)
        this.waiting.get(data.id)?.(data)
        this.waiting.delete(data.id)
      }
      this.all.push(worker)
      this.idle.push(worker)
    }
  }

  /** Workers free to take a chunk now. */
  get available() {
    return this.idle.length
  }

  /** Generate a chunk on a free worker (there must be one). */
  generate(seed: number, mode: WorldMode, cx: number, cy: number, kind: GenerateRequest['kind']) {
    const worker = this.idle.pop()!
    const id = this.nextId++
    const request: GenerateRequest = { id, seed, mode, cx, cy, kind }
    worker.postMessage(request)
    return new Promise<GenerateResult>((resolve) => this.waiting.set(id, resolve))
  }

  dispose() {
    for (const worker of this.all) worker.terminate()
    this.waiting.clear()
  }
}
