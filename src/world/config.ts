// URL parameters (`?chunkSize=128&worldChunks=48`). A generation worker is given the page's
// query as its name (world/generator.ts), since its own location is the worker script's.
const search = typeof window !== 'undefined' ? location.search : typeof self !== 'undefined' ? self.name : ''
const params = new URLSearchParams(search)

const intParam = (name: string, fallback: number) => {
  const value = Number(params.get(name))
  return params.has(name) && Number.isInteger(value) ? value : fallback
}

/** Cells across a chunk. A power of two, at least 64: the 4x4 air grid and 32-bit mask words must line up with chunks. */
export const CHUNK_SIZE = [64, 128, 256, 512].includes(intParam('chunkSize', 512)) ? intParam('chunkSize', 512) : 512

/** Chunks across the (square) world: 16 of the default size make 8192 cells. */
export const WORLD_CHUNKS = Math.min(256, Math.max(3, intParam('worldChunks', Math.round(8192 / CHUNK_SIZE))))

/** What the terrain and biomes are generated from: `?seed=` in the URL. */
export const WORLD_SEED = intParam('seed', 1996) >>> 0

export const WORLD_SIZE = CHUNK_SIZE * WORLD_CHUNKS

/**
 * Chunks the GPU holds at once (SandSim's slots): about 9 million cells, whatever the chunk
 * size, or `?slots=` in the URL. Enough for what the camera sees at its widest, a margin
 * around it, and the awake chunks elsewhere with their neighbours.
 */
export const SLOT_COUNT = Math.max(16, intParam('slots', Math.floor((144 * 256 * 256) / (CHUNK_SIZE * CHUNK_SIZE))))

/** Sand cells across an air cell (matches AIR_CELL in common.wgsl). */
export const AIR_CELL = 4
const AIR_CHUNK = CHUNK_SIZE / AIR_CELL

/**
 * A chunk's state as one array of 32-bit words, the way SandSim.readChunk and writeChunk
 * pass it: its cells, then its air grid (4 words per air cell), then its gauges (8).
 */
export const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE
export const CHUNK_AIR_WORDS = AIR_CHUNK * AIR_CHUNK * 4
export const CHUNK_GAUGE_WORDS = AIR_CHUNK * AIR_CHUNK * 8
export const CHUNK_WORDS = CHUNK_CELLS + CHUNK_AIR_WORDS + CHUNK_GAUGE_WORDS

/**
 * The page table the kernels find chunks through (SandSim.setTable, common.wgsl): a word per
 * chunk of the world, row by row (0 when it has no slot, else its slot + 1, with PAGE_LIVE
 * set when it is simulated), then the lists of chunks the kernels run over, each a count
 * and then up to SLOT_COUNT chunk indices (y * WORLD_CHUNKS + x).
 */
export const PAGE_LIVE = 0x80000000
export const TABLE_LISTS = WORLD_CHUNKS * WORLD_CHUNKS
export const LIST_STRIDE = SLOT_COUNT + 1
/** Live chunks; every chunk with a slot; chunks whose ground bodies collide with is measured; chunks bodies are near. */
export const List = { Live: 0, Resident: 1, Ground: 2, Bodies: 3 } as const
export const TABLE_WORDS = TABLE_LISTS + Object.keys(List).length * LIST_STRIDE

/** WGSL constants for the shared shader prelude. */
export const chunksWgsl = /* wgsl */ `
const CHUNK_SIZE: u32 = ${CHUNK_SIZE}u;
const WORLD_CHUNKS: u32 = ${WORLD_CHUNKS}u;
const WORLD_SIZE: u32 = ${WORLD_SIZE}u;
const SLOT_COUNT: u32 = ${SLOT_COUNT}u;
const PAGE_LIVE: u32 = ${PAGE_LIVE}u;
const TABLE_LISTS: u32 = ${TABLE_LISTS}u;
const LIST_STRIDE: u32 = ${LIST_STRIDE}u;
const LIST_LIVE: u32 = ${List.Live}u;
const LIST_RESIDENT: u32 = ${List.Resident}u;
const LIST_GROUND: u32 = ${List.Ground}u;
const LIST_BODIES: u32 = ${List.Bodies}u;
`
