import { materials } from '../sim/materials'
import { CHUNK_SIZE, WORLD_SIZE } from './config'

/** Cells across a texel of the overview (overview.ts). */
export const OVERVIEW_CELL = 4
/** Texels across a chunk's tile of the overview. */
export const TILE_SIDE = CHUNK_SIZE / OVERVIEW_CELL

/** A chunk's row and column sums, as activity.wgsl adds them up, from its state: the baseline its first scan is compared with. */
export function activitySums(data: Int32Array) {
  const sums = new Uint32Array(CHUNK_SIZE * 2)
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const m = data[y * CHUNK_SIZE + x] & 0xff
      if (m === 0) continue
      sums[y] += m + 1
      sums[CHUNK_SIZE + x] += m + 1
    }
  }
  return sums
}

/** Colours are authored in sRGB, and stored that way (Overview converts them as render.wgsl does). */
const toByte = (c: number) => Math.round(Math.min(c, 1) * 255)

/** The sky at a world row, as render.wgsl draws it (sRGB). */
export function sky(row: number) {
  const t = row / WORLD_SIZE
  return [0.06 + 0.06 * t, 0.08 + 0.06 * t, 0.14 + 0.08 * t]
}

/** A chunk's picture for the overview, from its cells (the first CHUNK_SIZE^2 words of its state): TILE_SIDE^2 sRGB texels, top row first. */
export function overviewTile(cy: number, cells: Int32Array) {
  const tile = new Uint8Array(TILE_SIDE * TILE_SIDE * 4)
  for (let y = 0; y < TILE_SIDE; y++) {
    const air = sky(cy * CHUNK_SIZE + y * OVERVIEW_CELL + 2)
    for (let x = 0; x < TILE_SIDE; x++) {
      const cell = cells[(y * OVERVIEW_CELL + 2) * CHUNK_SIZE + x * OVERVIEW_CELL + 2]
      const id = Math.min(cell & 0xff, materials.length - 1)
      const shade = 1 + materials[id].grain * (((cell >> 8) & 0xff) / 127.5 - 1)
      const color = id === 0 ? air : materials[id].color.map((c) => c * shade)
      tile.set([...color.map(toByte), 255], (y * TILE_SIDE + x) * 4)
    }
  }
  return tile
}
