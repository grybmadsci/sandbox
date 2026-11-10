import { materialByKey, type MaterialKey } from '../sim/materials'

/** A brush: paint a material, or the air brush (pressure and wind). */
export type Tool = MaterialKey | 'AIR'

/** Order shown in the HUD and bound to number keys 1..n. */
export const tools: Tool[] = ['SAND', 'WATER', 'OIL', 'SMOKE', 'STEAM', 'STONE', 'AIR', 'EMPTY', 'SOOT']

export const toolName = (tool: Tool) => (tool === 'AIR' ? 'Air' : materialByKey[tool].name)
