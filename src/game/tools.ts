import { materialByKey, type MaterialKey } from '../sim/materials'

/**
 * A brush: paint a material, the air brush (pressure and wind), the vacuum (takes air
 * out), or the inspect tool (shows the cell under the cursor).
 */
export type Tool = MaterialKey | 'AIR' | 'VACUUM' | 'INSPECT'

/** Order shown in the HUD, bound to number keys 1..9, then 0; inspect is I. */
export const tools: Tool[] = ['SAND', 'WATER', 'OIL', 'SMOKE', 'STEAM', 'STONE', 'AIR', 'EMPTY', 'SOOT', 'VACUUM', 'INSPECT']

/** The key for a tool at a position in `tools`. */
export const toolKey = (tool: Tool, index: number) => (tool === 'INSPECT' ? 'I' : String((index + 1) % 10))

export const toolName = (tool: Tool) =>
  tool === 'AIR' ? 'Air' : tool === 'VACUUM' ? 'Vacuum' : tool === 'INSPECT' ? 'Inspect' : materialByKey[tool].name
