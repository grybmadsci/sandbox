import type { MaterialKey } from '../sim/materials'
import { WORLD_SIZE } from './config'
import { fbm } from './noise'

/**
 * What a region of the world is made of. Surface biomes shape the ground; underground
 * biomes shape the caves. `color` is for the map (sRGB bytes).
 */
export type Biome = {
  name: string
  color: [number, number, number]
  /** The top layer of the ground, how many rows deep it goes, and the layer under it. */
  soil: MaterialKey
  soilDepth: number
  subsoil: MaterialKey
  subsoilDepth: number
  /** How wide winding tunnels are (a noise band, 0..0.5) and how much of the rock is open caverns (0..1). */
  tunnels: number
  caverns: number
  /** What fills the caves, and how much of them (0..1). */
  fill: MaterialKey
  fillAmount: number
}

const surface = (name: string, color: Biome['color'], soil: MaterialKey, soilDepth: number, subsoil: MaterialKey, subsoilDepth: number): Biome => ({
  name, color, soil, soilDepth, subsoil, subsoilDepth, tunnels: 0.045, caverns: 0.08, fill: 'EMPTY', fillAmount: 0,
})

const underground = (name: string, color: Biome['color'], tunnels: number, caverns: number, fill: MaterialKey, fillAmount: number): Biome => ({
  name, color, soil: 'STONE', soilDepth: 0, subsoil: 'STONE', subsoilDepth: 0, tunnels, caverns, fill, fillAmount,
})

export const biomes = {
  desert: surface('Desert', [222, 190, 112], 'SAND', 70, 'SAND', 30),
  meadow: surface('Meadow', [112, 148, 76], 'DIRT', 26, 'DIRT', 34),
  wetlands: surface('Wetlands', [72, 138, 124], 'DIRT', 18, 'SAND', 26),
  highlands: surface('Highlands', [132, 134, 146], 'STONE', 0, 'DIRT', 6),
  caverns: underground('Caverns', [92, 84, 104], 0.065, 0.36, 'EMPTY', 0),
  flooded: underground('Flooded caves', [46, 92, 158], 0.06, 0.32, 'WATER', 0.3),
  tar: underground('Tar pits', [76, 54, 32], 0.055, 0.28, 'OIL', 0.18),
  deep: underground('Deep rock', [58, 58, 66], 0.03, 0.12, 'SAND', 0.35),
} satisfies Record<string, Biome>

/** Cells across a typical biome: about a chunk and a quarter of the default size. */
const BIOME_SCALE = 620
/** How far (cells) noise pushes biome boundaries about, which makes them wander. */
const BIOME_WARP = 420

/** Where the ground would be without hills, in rows up from the bottom of the world. */
const BASELINE = Math.floor(WORLD_SIZE * 0.13) * 4

/** Noise bunches up around 0.5: stretch it so the biomes come out about evenly. */
const stretch = (n: number) => Math.min(1, Math.max(0, (n - 0.5) * 3.2 + 0.5))
const smooth = (t: number) => t * t * (3 - 2 * t)

/** How hot and how wet it is at a world position (0..1): domain-warped noise, so biome boundaries are organic. */
function climate(seed: number, x: number, y: number) {
  const warpX = (fbm(seed + 101, x / 300, y / 300, 3) - 0.5) * 2 * BIOME_WARP
  const warpY = (fbm(seed + 202, x / 300, y / 300, 3) - 0.5) * 2 * BIOME_WARP
  const wx = (x + warpX) / BIOME_SCALE
  const wy = (y + warpY) / BIOME_SCALE
  return { heat: stretch(fbm(seed + 303, wx, wy, 3)), wet: stretch(fbm(seed + 404, wx, wy, 3)) }
}

/** The surface row of the biome field: the ground's shape only depends on x. */
const surfaceClimate = (seed: number, x: number) => climate(seed, x, WORLD_SIZE - BASELINE)

const spawnX = WORLD_SIZE / 2
/** Columns either side of the spawn point that are level ground for the landmarks, and over how many more it blends back. */
const PAD_HALF_WIDTH = 560
const PAD_BLEND = 240

/** How flat the spawn pad makes the ground at a column: 1 on the pad, 0 away from it. */
export function padWeight(x: number) {
  const t = 1 - (Math.abs(x - spawnX) - PAD_HALF_WIDTH) / PAD_BLEND
  return smooth(Math.min(1, Math.max(0, t)))
}

/** Rows up from the bottom of the world that the level ground at the spawn pad is. */
export const padHeight = BASELINE

/** The height of the ground at a column, in rows up from the bottom of the world. */
export function surfaceHeight(seed: number, x: number) {
  const { heat, wet } = surfaceClimate(seed, x)
  const cold = 1 - heat
  const dry = 1 - wet
  const rolling = (fbm(seed + 505, x / 640, 0, 3) - 0.5) * 240
  const hills = (fbm(seed + 606, x / 150, 0, 4) - 0.5) * (30 + 260 * cold * cold)
  const dunes = (fbm(seed + 707, x / 70, 0, 2) - 0.5) * 70 * heat * dry
  const low = -70 * smooth(wet)
  const natural = BASELINE + rolling + hills + dunes + low
  return natural + (padHeight - natural) * padWeight(x)
}

/** Standing water fills low ground up to this height, so the wettest biomes get lakes that end at a natural shoreline. */
export function waterTable(seed: number, x: number) {
  const { wet } = surfaceClimate(seed, x)
  return BASELINE - 175 + 145 * smooth(wet) - 400 * padWeight(x)
}

/** Below this many rows under the ground is underground (give or take the noise, so the boundary wanders too). */
const SHALLOW_DEPTH = 110

/** The biome at a world position (y down), given the height of the ground in its column. */
export function biomeAt(seed: number, x: number, y: number, ground: number): Biome {
  const { heat, wet } = climate(seed, x, y)
  const up = WORLD_SIZE - y
  const depth = ground - up + (fbm(seed + 808, x / 180, y / 180, 2) - 0.5) * 140
  if (depth < SHALLOW_DEPTH) {
    if (heat > 0.5) return wet > 0.55 ? biomes.wetlands : biomes.desert
    return wet > 0.45 ? biomes.meadow : biomes.highlands
  }
  // Tar pits only where it's hottest: they're the rarest.
  if (heat > 0.75) return biomes.tar
  if (wet > 0.55) return biomes.flooded
  return heat < 0.35 && wet < 0.4 ? biomes.deep : biomes.caverns
}
