import { materials, type Material } from './materials'
import { CHUNK_SIZE } from '../world/config'

// Mirrors of constants in shaders/common.wgsl.
const AIR_ROW = 256
const AIR_AMBIENT = 1024 * AIR_ROW
const AIR_ONE = 1024
const HEAD_ONE = 16
const HEAD_BASE = 2048
const HEAD_INF = 0xffff
const DIST_INF = 0xfff
const FIELD_NONE = 0xffffffff

/** What the inspect tool shows for one cell (decoded from SandSim.inspect). */
export type Inspection = {
  x: number
  y: number
  /** Whether the cell's chunk is on the GPU (otherwise there's nothing else to tell). */
  loaded: boolean
  material: Material
  /** Liquid in transit held by this cell (pressure credit), in cells. */
  credit: number
  /** Liquids and gases: the way it flows sideways. */
  direction: 'left' | 'right'
  /** Liquids: rows of liquid pressure (depth below the body's highest surface, plus the air on it). */
  liquid: { pressure: number; head: number; hops: number; sinkDistance: number | null } | null
  /** The 4x4 air cell it is in. */
  air: {
    /** Air mass, in air cells' worth of still air at one atmosphere. */
    mass: number
    /** Open (empty or gas) sand cells, of 16; and the smoothed volume pressure uses. */
    open: number
    smoothedOpen: number
    /** Absolute pressure in atmospheres, and gauge pressure in rows of liquid. */
    atmospheres: number
    gaugeRows: number
    /** The time-averaged gauge pressure liquids feel, in rows. */
    feltRows: number
    /** Wind through the cell's right and bottom faces, in cells per step. */
    wind: [number, number]
  } | null
}

/** Decode the raw readout written by inspect.wgsl. */
export function decodeInspection(raw: Int32Array): Inspection {
  const cell = raw[0] >>> 0
  const field = raw[1] >>> 0
  const hopsPacked = raw[2] >>> 0
  const material = materials[Math.min(cell & 0xff, materials.length - 1)]

  let liquid: Inspection['liquid'] = null
  if (material.kind === 'liquid' && field !== FIELD_NONE && (field & 0xffff) !== HEAD_INF) {
    const hops = hopsPacked & 0xfff
    // Heads count from the top row of the cell's chunk.
    const highest = ((field & 0xffff) - hops) / HEAD_ONE - HEAD_BASE + Math.floor(raw[4] / CHUNK_SIZE) * CHUNK_SIZE
    const distance = (field >>> 18) & 0xfff
    liquid = {
      pressure: Math.max(raw[4] - highest, 0),
      head: highest,
      hops,
      sinkDistance: distance === DIST_INF ? null : distance,
    }
  }

  const slot = raw[8]
  let air: Inspection['air'] = null
  if (slot >= 0) {
    const soft = slot >> 10
    const absolute = soft > 0 ? Math.trunc((raw[5] * 1024) / soft) : 0
    air = {
      mass: raw[5] / AIR_AMBIENT,
      open: slot & 31,
      smoothedOpen: soft / 64,
      atmospheres: absolute / AIR_AMBIENT,
      gaugeRows: soft > 0 ? (absolute - AIR_AMBIENT) / AIR_ROW : 0,
      feltRows: raw[10] / AIR_ROW,
      wind: [raw[6] / 4 / AIR_ONE, raw[7] / 4 / AIR_ONE],
    }
  }

  return {
    x: raw[3],
    y: raw[4],
    loaded: raw[11] === 1,
    material,
    credit: material.kind === 'liquid' ? cell >>> 17 : 0,
    direction: (cell >> 16) & 1 ? 'left' : 'right',
    liquid,
    air,
  }
}
