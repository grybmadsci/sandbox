export type MaterialKind = 'empty' | 'solid' | 'powder' | 'liquid' | 'gas'

export type Material = {
  /** Cell value stored in the low 8 bits. Must be contiguous from 0; EMPTY must be 0. */
  id: number
  /** WGSL constant name (emitted as MAT_<key>). */
  key: string
  name: string
  kind: MaterialKind
  /**
   * Heavier materials sink through lighter non-solid ones. Empty space is 2, so
   * gases (below 2) rise through it and everything else falls.
   */
  density: number
  /** Base color, sRGB 0..1. */
  color: [number, number, number]
  /** Per-cell brightness variation, 0..1 (0 = flat color, 0.15 = very grainy). */
  grain: number
  /** Fraction of brush cells filled when painting (sparse sprays look grainier). */
  fill: number
  /**
   * Liquids and gases: how many cells sideways a resting liquid (or blocked gas) can
   * flow per simulation step. Higher spreads and levels out faster; each extra cell
   * costs one more GPU pass per step (passes = the highest value in the table).
   */
  spread: number
  /** How strongly wind moves it, 0..1 (0 = not at all, 1 = moves with the air). */
  drag: number
  /** Chance per step to turn into `decayInto` (smoke settles into soot, steam condenses). */
  decay: number
  decayInto: string
}

const inert = { drag: 0, decay: 0, decayInto: 'EMPTY' }

export const materials = [
  { id: 0, key: 'EMPTY', name: 'Eraser', kind: 'empty', density: 2, color: [0, 0, 0], grain: 0, fill: 1, spread: 0, ...inert },
  { id: 1, key: 'STONE', name: 'Stone', kind: 'solid', density: 255, color: [0.42, 0.43, 0.47], grain: 0.05, fill: 1, spread: 0, ...inert },
  { id: 2, key: 'SAND', name: 'Sand', kind: 'powder', density: 5, color: [0.86, 0.72, 0.42], grain: 0.06, fill: 0.5, spread: 0, ...inert, drag: 0.15 },
  { id: 3, key: 'WATER', name: 'Water', kind: 'liquid', density: 4, color: [0.2, 0.45, 0.88], grain: 0.02, fill: 0.7, spread: 8, ...inert, drag: 0.05 },
  { id: 4, key: 'OIL', name: 'Oil', kind: 'liquid', density: 3, color: [0.42, 0.3, 0.16], grain: 0.02, fill: 0.7, spread: 4, ...inert, drag: 0.05 },
  { id: 5, key: 'SMOKE', name: 'Smoke', kind: 'gas', density: 1, color: [0.38, 0.38, 0.42], grain: 0.08, fill: 0.5, spread: 2, drag: 1, decay: 0.0015, decayInto: 'SOOT' },
  { id: 6, key: 'STEAM', name: 'Steam', kind: 'gas', density: 0, color: [0.78, 0.84, 0.9], grain: 0.06, fill: 0.5, spread: 3, drag: 1, decay: 0.0008, decayInto: 'WATER' },
  // What smoke settles into, so it clears without losing mass. Light: floats on water, blows around.
  { id: 7, key: 'SOOT', name: 'Soot', kind: 'powder', density: 3, color: [0.17, 0.16, 0.16], grain: 0.1, fill: 0.5, spread: 0, ...inert, drag: 0.6 },
] as const satisfies readonly Material[]

export type MaterialKey = (typeof materials)[number]['key']

export const materialByKey = Object.fromEntries(materials.map((m) => [m.key, m])) as Record<
  MaterialKey,
  Material
>

/** Sideways flow passes per simulation step: enough for the fastest liquid or gas. */
export const maxSpread = Math.max(...materials.map((m) => m.spread))

const kindIds: Record<MaterialKind, number> = { empty: 0, solid: 1, powder: 2, liquid: 3, gas: 4 }

const f = (n: number) => n.toFixed(4)
/** Chances and drag are stored as 16-bit fixed point so the kernels stay integer-only (deterministic). */
const u16 = (n: number) => `${Math.round(Math.min(Math.max(n, 0), 1) * 65535)}u`

const table = (name: string, type: string, values: string[]) =>
  `var<private> ${name}: array<${type}, ${values.length}> = array<${type}, ${values.length}>(${values.join(', ')});`

/** WGSL declarations generated from the table above; part of the shared shader prelude. */
export const materialsWgsl = /* wgsl */ `
${materials.map((m) => `const MAT_${m.key}: u32 = ${m.id}u;`).join('\n')}

const KIND_EMPTY: u32 = 0u;
const KIND_SOLID: u32 = 1u;
const KIND_POWDER: u32 = 2u;
const KIND_LIQUID: u32 = 3u;
const KIND_GAS: u32 = 4u;

const MATERIAL_COUNT: u32 = ${materials.length}u;
${table('MATERIAL_KIND', 'u32', materials.map((m) => `${kindIds[m.kind]}u`))}
${table('MATERIAL_DENSITY', 'u32', materials.map((m) => `${m.density}u`))}
${table('MATERIAL_SPREAD', 'u32', materials.map((m) => `${m.spread}u`))}
${table('MATERIAL_DRAG', 'u32', materials.map((m) => u16(m.drag)))}
${table('MATERIAL_DECAY', 'u32', materials.map((m) => u16(m.decay)))}
${table('MATERIAL_DECAY_INTO', 'u32', materials.map((m) => `MAT_${m.decayInto}`))}
${table('MATERIAL_FILL', 'f32', materials.map((m) => f(m.fill)))}
${table('MATERIAL_GRAIN', 'f32', materials.map((m) => f(m.grain)))}
${table('MATERIAL_COLOR', 'vec3f', materials.map((m) => `vec3f(${m.color.map(f).join(', ')})`))}
`
