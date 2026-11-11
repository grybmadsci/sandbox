import { materialByKey, type MaterialKey } from '../sim/materials'

/**
 * A brush: paint a material, the air brush (pressure and wind), the vacuum (takes air
 * out), the inspect tool (shows the cell under the cursor), one that places a rigid
 * body (box, ball, beam), or one that places an object, only where it fits (mining
 * laser, vehicle).
 */
export type Tool = Exclude<MaterialKey, 'BODY'> | 'AIR' | 'VACUUM' | 'INSPECT' | BodyTool | ObjectTool
export type BodyTool = 'BOX' | 'BALL' | 'BEAM'
export type ObjectTool = 'LASER' | 'VEHICLE'

/** Order shown in the HUD, bound to number keys 1..9, then 0; the rest to letters (`letterKeys`). */
export const tools: Tool[] = ['SAND', 'WATER', 'OIL', 'SMOKE', 'STEAM', 'STONE', 'AIR', 'EMPTY', 'SOOT', 'VACUUM', 'DIRT', 'BOX', 'BALL', 'BEAM', 'LASER', 'VEHICLE', 'INSPECT']

/** Tools bound to letters, by KeyboardEvent.code. */
export const letterKeys: Partial<Record<Tool, string>> = { DIRT: 'KeyG', BOX: 'KeyB', BALL: 'KeyO', BEAM: 'KeyL', LASER: 'KeyM', VEHICLE: 'KeyV', INSPECT: 'KeyI' }

export const isBodyTool = (tool: Tool): tool is BodyTool => tool === 'BOX' || tool === 'BALL' || tool === 'BEAM'

export const isObjectTool = (tool: Tool): tool is ObjectTool => tool === 'LASER' || tool === 'VEHICLE'

/** Tools that place something by dragging, rather than painting. */
export const isPlacingTool = (tool: Tool): tool is BodyTool | ObjectTool => isBodyTool(tool) || isObjectTool(tool)

/** The key for a tool at a position in `tools`. */
export const toolKey = (tool: Tool, index: number) => letterKeys[tool]?.slice(3) ?? String((index + 1) % 10)

const names: Partial<Record<Tool, string>> = { AIR: 'Air', VACUUM: 'Vacuum', INSPECT: 'Inspect', BOX: 'Box', BALL: 'Ball', BEAM: 'Beam', LASER: 'Mining laser', VEHICLE: 'Vehicle' }

export const toolName = (tool: Tool) => names[tool] ?? materialByKey[tool as MaterialKey].name
