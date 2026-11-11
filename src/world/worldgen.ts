import { materialByKey } from '../sim/materials'
import { biomeAt, padHeight, padWeight, surfaceHeight, waterTable, type Biome } from './biomes'
import { CHUNK_AIR_WORDS, CHUNK_CELLS, CHUNK_SIZE, CHUNK_WORDS, WORLD_SIZE } from './config'
import { fbm, hashUnit, noise2 } from './noise'

/** Terrain from the seed, or nothing at all (the Clear key). */
export type WorldMode = 'terrain' | 'empty'

const EMPTY = materialByKey.EMPTY.id
const STONE = materialByKey.STONE.id
const SAND = materialByKey.SAND.id
const WATER = materialByKey.WATER.id

/** Cells generated beyond each side of a chunk, so what crosses into its neighbours comes out the same on both sides. */
const MARGIN = 4
/** Cells across the blocks a chunk's biomes are looked up in (they're slow to compute), and how far each cell jitters its lookup so block edges don't show. */
const BIOME_BLOCK = 8
const BIOME_JITTER = 7

const spawnX = WORLD_SIZE / 2

/** Where the world's landmarks and starting bodies stand, in cells (y down). */
export const spawnPoint = { x: spawnX, y: WORLD_SIZE - padHeight }

/**
 * A U-tube (connected vessels), left arm filled with water: static pressure levels it
 * out. And a bell siphon, on the ground: a reservoir pours slowly through holes in its
 * floor into a basin; in the basin a standpipe rises to a rim, under an inverted cup (the
 * bell) whose skirt stops just above the basin floor, and its lower end dips 4 rows into
 * a wide cup that spills into a catch pool. As the basin rises, the air trapped in the
 * bell is squeezed out under the standpipe's end. Once the basin overflows the rim, the
 * water pouring down the standpipe drags the rest of the bell's air out with it; the
 * suction pulls the cup's water up the standpipe until it meets the pour, and static
 * pressure drains the basin into the cup until air gets in under the skirt. Walls are 4
 * cells thick on 4-cell boundaries, so the 4x4 air grid seals each pocket. `up` is rows
 * up from the bottom of the world. Returns the material at a cell, or -1 outside them.
 */
function landmarkAt(x: number, up: number): number {
  const tubeLeft = spawnX - 420
  const tubeBottom = padHeight + 200
  if (x >= tubeLeft && x < tubeLeft + 96 && up >= tubeBottom && up < tubeBottom + 130) {
    const tx = x - tubeLeft
    const ty = up - tubeBottom
    const channel = ty >= 4 && ty < 16 && tx >= 4 && tx < 92
    const leftArm = ty >= 4 && tx >= 4 && tx < 20
    const rightArm = ty >= 4 && tx >= 76 && tx < 92
    if ((leftArm && ty < 120) || (channel && tx < 76)) return WATER
    return channel || leftArm || rightArm ? EMPTY : STONE
  }

  // (mx, my: cells from its bottom left.)
  const mx = x - (spawnX + 128)
  const my = up - 1 - padHeight
  if (mx < 0 || mx >= 224 || my < 0 || my >= 320) return -1
  let cell = EMPTY
  const catchPool = my < 4 || ((mx < 4 || mx >= 220) && my < 60)
  // The cup spills over its lower right wall at 64.
  const cup = (my >= 52 && my < 56 && mx >= 124 && mx < 164)
    || (my >= 52 && my < 72 && mx >= 124 && mx < 128)
    || (my >= 52 && my < 64 && mx >= 160 && mx < 164)
  const basin = (my >= 100 && my < 104 && mx >= 60 && mx < 168)
    || (my >= 100 && my < 172 && ((mx >= 60 && mx < 64) || (mx >= 164 && mx < 168)))
  // Bell: walls from a block above the basin floor, cap a block above the rim (144).
  const bell = (my >= 108 && my < 152 && ((mx >= 124 && mx < 128) || (mx >= 152 && mx < 156)))
    || (my >= 148 && my < 152 && mx >= 124 && mx < 156)
  const standpipe = my >= 60 && my < 144 && mx >= 132 && mx < 144
  const bore = my >= 60 && my < 144 && mx >= 136 && mx < 140
  // Reservoir, full of water, floor at 216-220 with three spout holes over the basin
  // (5 apart, so the stone between them is 4 thick).
  const spout = (mx === 90 || mx === 95 || mx === 100) && my < 220
  const reservoir = (my >= 216 && my < 220 && mx >= 24 && mx < 196 && !spout)
    || (my >= 216 && ((mx >= 24 && mx < 28) || (mx >= 192 && mx < 196)))
  if ((catchPool || cup || basin || bell || standpipe || reservoir) && !bore) cell = STONE
  // Water: the reservoir, and the cup filled to its lip (over the standpipe's end).
  if ((my >= 220 && my < 300 && mx >= 28 && mx < 192) || (cell === EMPTY && my >= 56 && my < 64 && mx >= 128 && mx < 160)) cell = WATER
  return cell
}

/** What the ground is made of at a depth below its surface, in a biome, if not a cave. */
function groundAt(biome: Biome, depth: number): number {
  if (depth < biome.soilDepth) return materialByKey[biome.soil].id
  if (depth < biome.soilDepth + biome.subsoilDepth) return materialByKey[biome.subsoil].id
  return STONE
}

/**
 * Generate a chunk's cells from the seed, into the first CHUNK_CELLS words of a chunk's
 * state, and mark its air as not yet initialised (still air at ambient pressure, once
 * the chunk is live). Every cell depends only on the seed and its world position, so
 * neighbouring chunks meet exactly.
 */
export function generateChunk(seed: number, mode: WorldMode, cx: number, cy: number, out = new Int32Array(CHUNK_WORDS)) {
  out.fill(0)
  for (let i = 3; i < CHUNK_AIR_WORDS; i += 4) out[CHUNK_CELLS + i] = -1
  if (mode === 'empty') return out

  const span = CHUNK_SIZE + MARGIN * 2
  const x0 = cx * CHUNK_SIZE - MARGIN
  const y0 = cy * CHUNK_SIZE - MARGIN
  const solid = new Uint8Array(span * span)
  const grid = new Uint8Array(span * span)
  const grounds = new Float64Array(span)
  const tables = new Float64Array(span)
  for (let x = 0; x < span; x++) {
    grounds[x] = surfaceHeight(seed, x0 + x)
    tables[x] = waterTable(seed, x0 + x)
  }

  // Biomes, in blocks around the chunk (lookups jitter up to BIOME_JITTER past its edge).
  const blocks = Math.ceil((span + BIOME_JITTER * 2) / BIOME_BLOCK) + 1
  const blockBiomes: Biome[] = []
  const blockAt = (a: number, b: number) => (Math.floor((a - x0 + BIOME_JITTER) / BIOME_BLOCK) + Math.floor((b - y0 + BIOME_JITTER) / BIOME_BLOCK) * blocks)
  for (let b = 0; b < blocks; b++) {
    for (let a = 0; a < blocks; a++) {
      const wx = x0 - BIOME_JITTER + a * BIOME_BLOCK + BIOME_BLOCK / 2
      const wy = y0 - BIOME_JITTER + b * BIOME_BLOCK + BIOME_BLOCK / 2
      const column = Math.min(span - 1, Math.max(0, wx - x0))
      blockBiomes.push(biomeAt(seed, wx, wy, grounds[column]))
    }
  }

  for (let y = 0; y < span; y++) {
    const wy = y0 + y
    const up = WORLD_SIZE - wy
    for (let x = 0; x < span; x++) {
      const wx = x0 + x
      const i = y * span + x
      const ground = grounds[x]
      let cell = EMPTY
      if (up < ground) {
        const jx = Math.floor((hashUnit(seed + 11, wx, wy) - 0.5) * 2 * BIOME_JITTER)
        const jy = Math.floor((hashUnit(seed + 12, wx, wy) - 0.5) * 2 * BIOME_JITTER)
        const biome = blockBiomes[blockAt(wx + jx, wy + jy)]
        const depth = ground - up
        cell = groundAt(biome, depth)
        // Caves (none right under the ground, or under the landmarks): winding tunnels along
        // the contours of two noise fields, whose networks cross each other everywhere, so
        // the tunnels join up and run between the caverns. The fields are stretched sideways,
        // so tunnels mostly wind along rather than down, and caverns are wider than tall:
        // levels of caves, joined now and then.
        if (depth > (padWeight(wx) > 0 ? 300 : 26) && wy < WORLD_SIZE - 12) {
          const tunnel = Math.abs(noise2(seed + 21, wx / 220, wy / 55) - 0.5) < biome.tunnels
            || Math.abs(noise2(seed + 24, wx / 280, wy / 48) - 0.5) < biome.tunnels * 0.8
          const cavern = (fbm(seed + 22, wx / 280, wy / 90, 3) - 0.5) * 3.2 + 0.5 > 1 - biome.caverns
          if (tunnel || cavern) {
            cell = fbm(seed + 23, wx / 70, wy / 70, 2) < biome.fillAmount ? materialByKey[biome.fill].id : EMPTY
          }
        }
      } else if (up < tables[x]) {
        cell = WATER
      }
      const landmark = landmarkAt(wx, up)
      if (landmark >= 0) cell = landmark
      grid[i] = cell
      solid[i] = cell === STONE ? 1 : 0
    }
  }

  // Stone must be at least 4 cells thick (crumble.wgsl): what no 4x4 square of stone covers is sand.
  const covered = new Uint8Array(span * span)
  for (let y = 0; y + 3 < span; y++) {
    for (let x = 0; x + 3 < span; x++) {
      let all = 1
      for (let d = 0; d < 16 && all; d++) all = solid[(y + (d >> 2)) * span + x + (d & 3)]
      if (all) for (let d = 0; d < 16; d++) covered[(y + (d >> 2)) * span + x + (d & 3)] = 1
    }
  }

  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const i = (y + MARGIN) * span + x + MARGIN
      let cell = grid[i]
      if (cell === STONE && !covered[i]) cell = SAND
      if (cell !== EMPTY) {
        // A random shade and flow direction (makeCell in common.wgsl).
        const variant = Math.floor(hashUnit(seed + 31, x0 + x + MARGIN, y0 + y + MARGIN) * 512)
        cell |= variant << 8
      }
      out[y * CHUNK_SIZE + x] = cell
    }
  }
  return out
}

