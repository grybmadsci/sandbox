export type MaterialKind = 'empty' | 'solid' | 'powder' | 'liquid'

export type Material = {
  /** Cell value stored in the low 8 bits. Must be contiguous from 0; EMPTY must be 0. */
  id: number
  /** WGSL constant name (emitted as MAT_<key>). */
  key: string
  name: string
  kind: MaterialKind
  /** Heavier materials sink through lighter non-solid ones. */
  density: number
  /** Base color, sRGB 0..1. */
  color: [number, number, number]
  /** Per-cell brightness variation, 0..1 (0 = flat color, 0.15 = very grainy). */
  grain: number
  /** Fraction of brush cells filled when painting (sparse sprays look grainier). */
  fill: number
  /**
   * Liquids only: how many cells sideways a resting liquid can flow per simulation
   * step. Higher spreads and levels out faster; each extra cell costs one more GPU
   * pass per step (passes = the highest value in the table). 0 for everything else.
   */
  spread: number
}

export const materials = [
  { id: 0, key: 'EMPTY', name: 'Eraser', kind: 'empty', density: 0, color: [0, 0, 0], grain: 0, fill: 1, spread: 0 },
  { id: 1, key: 'STONE', name: 'Stone', kind: 'solid', density: 255, color: [0.42, 0.43, 0.47], grain: 0.05, fill: 1, spread: 0 },
  { id: 2, key: 'SAND', name: 'Sand', kind: 'powder', density: 3, color: [0.86, 0.72, 0.42], grain: 0.06, fill: 0.5, spread: 0 },
  { id: 3, key: 'WATER', name: 'Water', kind: 'liquid', density: 2, color: [0.2, 0.45, 0.88], grain: 0.02, fill: 0.7, spread: 8 },
  { id: 4, key: 'OIL', name: 'Oil', kind: 'liquid', density: 1, color: [0.42, 0.3, 0.16], grain: 0.02, fill: 0.7, spread: 4 },
] as const satisfies readonly Material[]

export type MaterialKey = (typeof materials)[number]['key']

export const materialByKey = Object.fromEntries(materials.map((m) => [m.key, m])) as Record<
  MaterialKey,
  Material
>

/** Sideways flow passes per simulation step: enough for the fastest liquid. */
export const maxSpread = Math.max(...materials.map((m) => m.spread))

/** Order shown in the HUD and bound to number keys 1..n. */
export const palette: MaterialKey[] = ['SAND', 'WATER', 'OIL', 'STONE', 'EMPTY']

const kindIds: Record<MaterialKind, number> = { empty: 0, solid: 1, powder: 2, liquid: 3 }

const f = (n: number) => n.toFixed(4)

/** WGSL declarations generated from the table above; part of the shared shader prelude. */
export const materialsWgsl = /* wgsl */ `
${materials.map((m) => `const MAT_${m.key}: u32 = ${m.id}u;`).join('\n')}

const KIND_EMPTY: u32 = 0u;
const KIND_SOLID: u32 = 1u;
const KIND_POWDER: u32 = 2u;
const KIND_LIQUID: u32 = 3u;

const MATERIAL_COUNT: u32 = ${materials.length}u;
var<private> MATERIAL_KIND: array<u32, ${materials.length}> = array<u32, ${materials.length}>(${materials.map((m) => `${kindIds[m.kind]}u`).join(', ')});
var<private> MATERIAL_DENSITY: array<u32, ${materials.length}> = array<u32, ${materials.length}>(${materials.map((m) => `${m.density}u`).join(', ')});
var<private> MATERIAL_SPREAD: array<u32, ${materials.length}> = array<u32, ${materials.length}>(${materials.map((m) => `${m.spread}u`).join(', ')});
var<private> MATERIAL_FILL: array<f32, ${materials.length}> = array<f32, ${materials.length}>(${materials.map((m) => f(m.fill)).join(', ')});
var<private> MATERIAL_GRAIN: array<f32, ${materials.length}> = array<f32, ${materials.length}>(${materials.map((m) => f(m.grain)).join(', ')});
var<private> MATERIAL_COLOR: array<vec3f, ${materials.length}> = array<vec3f, ${materials.length}>(${materials.map((m) => `vec3f(${m.color.map(f).join(', ')})`).join(', ')});
`
