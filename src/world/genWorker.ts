// Generates chunks off the main thread (generator.ts). Its URL parameters come in as its
// name, which world/config.ts reads.
import { activitySums, overviewTile } from './chunkData'
import { generateChunk } from './worldgen'
import type { GenerateRequest, GenerateResult } from './generator'

self.onmessage = ({ data: { id, seed, mode, cx, cy, kind } }: MessageEvent<GenerateRequest>) => {
  const data = generateChunk(seed, mode, cx, cy)
  const tile = overviewTile(cy, data)
  if (kind === 'tile') {
    self.postMessage({ id, tile } satisfies GenerateResult, { transfer: [tile.buffer] })
    return
  }
  const sums = activitySums(data)
  self.postMessage({ id, data, sums, tile } satisfies GenerateResult, { transfer: [data.buffer, sums.buffer, tile.buffer] })
}
