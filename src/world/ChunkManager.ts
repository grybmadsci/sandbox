import type { WebGPURenderer } from 'three/webgpu'
import { materialByKey } from '../sim/materials'
import { ACTIVITY_INTS, type ListCounts, type SandSim } from '../sim/SandSim'
import { BODY_MAX_LOAD, BodyWorld, levelBodies, type SavedGroup } from '../sim/bodies'
import { CHUNK_CELLS, CHUNK_SIZE, CHUNK_WORDS, LIST_STRIDE, List, PAGE_LIVE, SLOT_COUNT, TABLE_LISTS, TABLE_WORDS, WORLD_CHUNKS } from './config'
import { activitySums } from './chunkData'
import { ChunkGenerator } from './generator'
import { generateChunk, spawnPoint, type WorldMode } from './worldgen'
import type { Overview } from './overview'
import type { SaveGame, SaveHeader } from './save'

/** Steps between activity scans (a quarter of a second at 120 steps a second). */
export const SCAN_EVERY_STEPS = 30
/** A live chunk outside the camera's neighbourhood goes to sleep after this many simulated seconds without a nontrivial change. */
export const UNLOAD_AFTER_SECONDS = 5
/**
 * How much a chunk's row sums, or its column sums (activity.wgsl), must change between
 * scans for it to count as a nontrivial change: the total difference, in material ids + 1
 * (a grain of dirt falling changes two rows by 10 each). Rows catch falling and filling,
 * columns flowing along. This is about 20 falling grains: a cave ceiling or an overhang
 * dribbling a grain at a time shouldn't keep a chunk awake, nor the surface of a pool that
 * has settled, whose cells slide back and forth (about 50 a scan on a chunk of 512).
 */
export const CHANGE_THRESHOLD = 400
/**
 * How much the sums along a side of a chunk must change (its outermost EDGE_CELLS rows,
 * or columns) to wake the chunk beyond it: something is reaching it (more than a stray
 * grain or two).
 */
export const EDGE_THRESHOLD = 80
const EDGE_CELLS = 4
/** Cells the camera must go past a chunk's edge before it counts as in the next chunk, so it can hover at an edge without its neighbourhood changing back and forth. */
const CAMERA_SLACK = 32
/**
 * Cells around what the camera sees whose chunks are loaded ahead of it, so the edge of
 * the screen doesn't reach a chunk still loading while it pans; and, a chunk further, the
 * cells whose chunks stay loaded once they are, so panning back and forth doesn't load
 * and unload the same chunks.
 */
const PRELOAD_CELLS = 256
const KEEP_CELLS = PRELOAD_CELLS + CHUNK_SIZE
/** Slots the camera's chunks leave for awake chunks elsewhere (and their neighbours): when it sees more than the rest, the nearest are loaded and the overview shows the others. */
const SLOT_RESERVE = Math.ceil(SLOT_COUNT / 5)
/** Chunks written to the GPU per frame at most (CHUNK_WORDS words each), and while the world is first loading (nothing runs meanwhile). */
const LOADS_PER_FRAME = 4
const LOADS_PER_FRAME_LOADING = 64
/** Generated chunks kept until they're loaded (generated ahead of the camera), at most: a few megabytes' worth. */
const GENERATED_MAX = Math.max(16, Math.floor((32 * 256 * 256) / CHUNK_CELLS))
/**
 * Steps a new world is simulated for behind the loading screen, every chunk on the GPU
 * awake, so what generation leaves hanging (loose sand over caves, water above them) has
 * fallen and settled before the player sees it: 3 seconds. SandWorld runs them a few a frame.
 */
export const SETTLE_STEPS = 360
/** Cells inside the loaded chunks' edge a put-away body must be before it is brought back. */
const RESTORE_MARGIN = 8
/** Cells around bodies whose ground is measured for their collider, so a fast body never reaches unmeasured ground. */
const GROUND_MARGIN = 48
/** How far around bodies their kernels look (bodyForces.wgsl, carry.wgsl): sideways, above (the piles on them) and below. */
const BODY_SIDE_MARGIN = 8
const BODY_TOP_MARGIN = BODY_MAX_LOAD + 8
const BODY_BOTTOM_MARGIN = 8

const BODY = materialByKey.BODY.id

/** How a chunk is, for the world map. */
export const ChunkState = {
  /** Not on the GPU, as generated: generated from the seed when needed. */
  Pristine: 0,
  /** Not on the GPU, kept (it has changed). */
  Stored: 1,
  /** On the GPU, not simulated (asleep): a wall to the live chunks beside it. */
  Frozen: 2,
  Live: 3,
} as const

/** What the camera sees (world cells): its centre and its corners. */
export type View = { x: number; y: number; x0: number; y0: number; x1: number; y1: number }

class Chunk {
  /** The GPU slot it's in, or -1 when it isn't on the GPU. */
  slot = -1
  /** Simulated (only with a slot). */
  live = false
  /** Woken while it had no slot: it goes live once loaded. */
  wanted = false
  /** Has changed since it was generated: its state must be kept (`data`) when it is unloaded. */
  dirty = false
  /** The GPU's copy has changes `data` doesn't have yet. */
  unsaved = false
  /** Its state as last read back or loaded, or null when it is as generated. */
  data: Int32Array | null = null
  /** When it last changed nontrivially, in simulated seconds. */
  lastChange = 0
  /** A readback in flight, which sets `data`. */
  reading: Promise<void> | null = null
  /** Drawn in the overview. */
  drawn = false
  /** Its row and column sums (activity.wgsl) at the last activity scan, or as written to the GPU. */
  sums: Uint32Array | null = null
  /** Bumped each time it's loaded: a readback from before is for what was in its slot then. */
  serial = 0
  /** The ground bodies collide with has been measured here since it was loaded and bodies came near. */
  measured = false
}

/**
 * Splits the world into WORLD_CHUNKS x WORLD_CHUNKS chunks and decides which are on the
 * GPU (SandSim has SLOT_COUNT slots for them) and which of those are simulated.
 *
 * Awake (live) chunks are simulated wherever they are, on screen or not. The camera's
 * chunk and its 8 neighbours are always awake. Any other chunk stays awake until it has
 * gone UNLOAD_AFTER_SECONDS without a nontrivial change (CHANGE_THRESHOLD between scans),
 * then sleeps: it stays on the GPU, still drawn, frozen, a wall to the chunks beside it.
 * A chunk wakes when the camera comes near, when something in an awake chunk beside it
 * reaches its edge, when the player paints in it, or when a body moves or a laser fires
 * in it.
 *
 * On the GPU are the chunks around what the camera sees (PRELOAD_CELLS beyond it, loaded
 * a few a frame ahead of it, generated in workers before that), the awake chunks, and as
 * many of their 8 neighbours as there's room for (so a chunk woken from beside is there at
 * once; otherwise it's loaded when woken, and goes live then). Everything else is
 * unloaded once it is further than KEEP_CELLS from the view: read back and kept on the
 * CPU if it has changed, otherwise generated again from the seed when needed, and drawn
 * from the overview meanwhile.
 *
 * Bodies reaching chunks that aren't on the GPU are put away (with what they were doing)
 * and brought back once the chunks are loaded again and their ground has been measured.
 */
export class ChunkManager {
  seed: number
  mode: WorldMode = 'terrain'
  private readonly chunks = Array.from({ length: WORLD_CHUNKS * WORLD_CHUNKS }, () => new Chunk())
  /** The chunk in each slot, or -1. */
  private readonly slots = new Int32Array(SLOT_COUNT).fill(-1)
  private readonly freeSlots: number[] = []
  /** What the camera sees, and its chunk (with slack, see CAMERA_SLACK). */
  private view: View = { x: 0, y: 0, x0: 0, y0: 0, x1: 0, y1: 0 }
  private camera: [number, number] | null = null
  private dormant: SavedGroup[] = []
  private readonly generator = new ChunkGenerator()
  private generated = new Map<number, { data: Int32Array; sums: Uint32Array }>()
  private requested = new Set<number>()
  /** Bumped whenever the world is replaced: what was asked of the workers, or read back, before is for another world. */
  private epoch = 0
  private scanning = false
  private lastScan = 0
  private readingGround = false
  /** The page table and lists (world/config.ts), and whether they need uploading. */
  private readonly table = new Uint32Array(TABLE_WORDS)
  private tableChanged = true
  private liveList: number[] = []
  private groundList: number[] = []
  private bodiesList: number[] = []
  /** Still loading the chunks around the camera after a reset or load: nothing is simulated until they're in. */
  private loadingView = true
  private progress = { done: 0, total: 1 }
  /** Steps of settling a new world still has to run (SETTLE_STEPS), once it's loaded. */
  private settleSteps = 0

  private readonly sim: SandSim
  private readonly renderer: WebGPURenderer
  private readonly bodies: BodyWorld
  private readonly overview: Overview
  private readonly stepsPerSecond: number

  constructor(sim: SandSim, renderer: WebGPURenderer, bodies: BodyWorld, overview: Overview, seed: number, stepsPerSecond: number) {
    this.sim = sim
    this.renderer = renderer
    this.bodies = bodies
    this.overview = overview
    this.seed = seed
    this.stepsPerSecond = stepsPerSecond
    for (let slot = SLOT_COUNT - 1; slot >= 0; slot--) this.freeSlots.push(slot)
  }

  /** The simulation's clock, in seconds: sleeping follows simulated time, so it is the same at any frame rate (and stops while paused). */
  private get now() {
    return this.sim.steps / this.stepsPerSecond
  }

  /**
   * Whether the world is still getting ready (after a reset or load), and how far along it
   * is: loading the chunks around the camera (in chunks), then, for a new world, settling
   * (in steps). The game waits meanwhile.
   */
  get loading(): { phase: 'loading' | 'settling'; done: number; total: number } | null {
    if (this.loadingView) return { phase: 'loading', ...this.progress }
    if (this.settleSteps > 0) return { phase: 'settling', done: SETTLE_STEPS - this.settleSteps, total: SETTLE_STEPS }
    return null
  }

  /** While settling: run by SandWorld after each step it runs to settle the world. */
  settled() {
    this.settleSteps = Math.max(0, this.settleSteps - 1)
  }

  private index(cx: number, cy: number) {
    return cy * WORLD_CHUNKS + cx
  }

  private inWorld(cx: number, cy: number) {
    return cx >= 0 && cy >= 0 && cx < WORLD_CHUNKS && cy < WORLD_CHUNKS
  }

  /** Chunks overlapping a region of the world (cells: min x, min y, max x, max y), as indices. */
  private *overlapping(x0: number, y0: number, x1: number, y1: number) {
    const lo = (v: number) => Math.max(0, Math.floor(v / CHUNK_SIZE))
    const hi = (v: number) => Math.min(WORLD_CHUNKS - 1, Math.floor(v / CHUNK_SIZE))
    for (let cy = lo(y0); cy <= hi(y1); cy++) for (let cx = lo(x0); cx <= hi(x1); cx++) yield this.index(cx, cy)
  }

  /** A chunk and its 8 neighbours, as indices. */
  private *neighbourhood(i: number) {
    const cx = i % WORLD_CHUNKS
    const cy = Math.floor(i / WORLD_CHUNKS)
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (this.inWorld(x, y)) yield this.index(x, y)
  }

  /** How far a chunk's centre is from the camera's, in cells. */
  private distance(i: number) {
    const x = ((i % WORLD_CHUNKS) + 0.5) * CHUNK_SIZE
    const y = (Math.floor(i / WORLD_CHUNKS) + 0.5) * CHUNK_SIZE
    return Math.hypot(x - this.view.x, y - this.view.y)
  }

  /** The chunks within `margin` cells of the view, nearest first, at most `most` of them. */
  private around(margin: number, most: number) {
    const { x0, y0, x1, y1 } = this.view
    const near = [...this.overlapping(x0 - margin, y0 - margin, x1 + margin, y1 + margin)]
    return near.sort((a, b) => this.distance(a) - this.distance(b)).slice(0, most)
  }

  /** Start a new world (from the seed, or empty), with the starting bodies. */
  reset(mode: WorldMode) {
    this.mode = mode
    this.replace(mode === 'terrain' ? levelBodies(spawnPoint.x, spawnPoint.y).map((spec) => ({ parts: [{ ...spec, vx: 0, vy: 0, spin: 0 }], joints: [] })) : [])
    this.settleSteps = mode === 'terrain' ? SETTLE_STEPS : 0
  }

  /** Forget the world: every chunk as generated and off the GPU, the given bodies put away (they come back as their chunks load). */
  private replace(bodies: SavedGroup[]) {
    for (const chunk of this.chunks) Object.assign(chunk, new Chunk())
    this.slots.fill(-1)
    this.freeSlots.length = 0
    for (let slot = SLOT_COUNT - 1; slot >= 0; slot--) this.freeSlots.push(slot)
    this.generated.clear()
    this.requested.clear()
    this.overview.clear()
    this.bodies.clear()
    this.sim.clear()
    this.dormant = bodies
    this.camera = null
    this.lastScan = 0
    this.loadingView = true
    this.tableChanged = true
    this.epoch++
  }

  /** The camera's chunk, keeping the one it was in until it is CAMERA_SLACK cells past its edge. */
  private cameraChunk(x: number, y: number): [number, number] {
    const pick = (p: number, current: number | undefined) => {
      const c = Math.min(WORLD_CHUNKS - 1, Math.max(0, Math.floor(p / CHUNK_SIZE)))
      if (current === undefined || c === current) return c
      const inside = p >= current * CHUNK_SIZE - CAMERA_SLACK && p < (current + 1) * CHUNK_SIZE + CAMERA_SLACK
      return inside ? current : c
    }
    return [pick(x, this.camera?.[0]), pick(y, this.camera?.[1])]
  }

  /**
   * Once a frame, before stepping: follow the camera (what it sees, world cells), keep its
   * neighbourhood awake, load and unload chunks, and put bodies away or bring them back.
   */
  update(view: View) {
    this.view = view
    this.camera = this.cameraChunk(view.x, view.y)
    const [camX, camY] = this.camera
    for (let y = camY - 1; y <= camY + 1; y++) for (let x = camX - 1; x <= camX + 1; x++) if (this.inWorld(x, y)) this.wake(x, y)

    // Awake chunks are needed wherever they are (they're simulated), as is what the camera
    // sees; only if they need more slots than there are do the furthest go to sleep. Their
    // neighbours are loaded too while there's room, nearest the camera first, so a chunk
    // woken from beside is there at once; one without a slot is loaded when it's woken.
    const budget = SLOT_COUNT - SLOT_RESERVE
    const preload = this.around(PRELOAD_CELLS, budget)
    let needed: Set<number>
    let awake: number[]
    for (;;) {
      needed = new Set(preload)
      awake = this.chunks.flatMap((chunk, i) => (chunk.live || chunk.wanted ? [i] : []))
      for (const i of awake) needed.add(i)
      if (needed.size <= SLOT_COUNT) break
      const furthest = awake.filter((i) => !this.nearCamera(i)).sort((a, b) => this.distance(b) - this.distance(a))[0]
      if (furthest === undefined) break
      this.sleep(furthest)
    }
    const beside = new Set<number>()
    for (const i of awake) for (const j of this.neighbourhood(i)) if (!needed.has(j)) beside.add(j)
    for (const j of [...beside].sort((a, b) => this.distance(a) - this.distance(b))) {
      if (needed.size >= SLOT_COUNT) break
      needed.add(j)
    }
    const kept = new Set([...needed, ...this.around(KEEP_CELLS, budget)])

    // Unload what's no longer kept (bodies on it are put away first).
    const leaving = new Set<number>()
    for (const i of this.slots) if (i >= 0 && !kept.has(i)) leaving.add(i)
    this.putAwayBodies(leaving)
    for (const i of leaving) this.unload(i)

    // Load what's needed, nearest first (woken chunks before anything), as far as it's
    // generated; making room if need be from chunks that are kept but not needed, furthest first.
    const order = [...needed].filter((i) => this.chunks[i].slot < 0)
    order.sort((a, b) => Number(this.chunks[b].wanted) - Number(this.chunks[a].wanted) || this.distance(a) - this.distance(b))
    const ready = order.filter((i) => !this.chunks[i].reading && (this.chunks[i].data || this.generated.has(i)))
    const loads = ready.slice(0, this.loadingView ? LOADS_PER_FRAME_LOADING : LOADS_PER_FRAME)
    const short = loads.length - this.freeSlots.length
    if (short > 0) {
      const spare = [...this.slots].filter((i) => i >= 0 && !needed.has(i))
      const making = new Set(spare.sort((a, b) => this.distance(b) - this.distance(a)).slice(0, short))
      this.putAwayBodies(making)
      for (const i of making) this.unload(i)
    }
    for (const i of loads) this.loadChunk(i)
    this.requestGeneration(order, kept)

    // Ready once everything around the camera is in (not only what it sees, so it all settles).
    if (this.loadingView) {
      this.progress = { done: preload.filter((i) => this.chunks[i].slot >= 0).length, total: preload.length }
      if (this.progress.done === this.progress.total) this.loadingView = false
    }
    // Settling: everything on the GPU stays awake (and has its full time awake after).
    if (!this.loadingView && this.settleSteps > 0) for (const i of this.slots) if (i >= 0) this.wake(i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS))

    this.updateBodyLists()
    // Bodies come back once the ground has settled under them.
    if (!this.loading) this.restoreBodies()
    this.sync()
  }

  private nearCamera(i: number) {
    const [camX, camY] = this.camera ?? [-9, -9]
    return Math.abs((i % WORLD_CHUNKS) - camX) <= 1 && Math.abs(Math.floor(i / WORLD_CHUNKS) - camY) <= 1
  }

  /**
   * Ask the workers for chunks that will be needed: those needed now that aren't
   * generated (in `order`), then the rest of the kept area around the view, then tiles of
   * the overview for chunks never drawn, nearest first.
   */
  private requestGeneration(order: number[], kept: Set<number>) {
    if (this.mode === 'empty') {
      // Nothing to generate: an empty chunk is quicker to make here.
      for (const i of order) {
        if (this.chunks[i].data || this.generated.has(i)) continue
        this.generated.set(i, { data: generateChunk(this.seed, 'empty', 0, 0), sums: new Uint32Array(ACTIVITY_INTS) })
      }
      return
    }
    const wanted = (i: number) => !this.chunks[i].data && !this.generated.has(i) && !this.requested.has(i)
    const ahead = [...kept].filter((i) => this.chunks[i].slot < 0).sort((a, b) => this.distance(a) - this.distance(b))
    const queue = [...order, ...ahead].filter(wanted)
    const epoch = this.epoch
    while (this.generator.available > 0 && queue.length > 0 && this.generated.size + this.requested.size < GENERATED_MAX) {
      const i = queue.shift()!
      this.requested.add(i)
      this.generator.generate(this.seed, this.mode, i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS), 'chunk').then(({ data, sums, tile }) => {
        if (epoch !== this.epoch) return
        this.requested.delete(i)
        if (!this.chunks[i].drawn) this.drawTile(i, tile)
        if (!this.chunks[i].data && this.chunks[i].slot < 0) this.generated.set(i, { data: data!, sums: sums! })
      })
    }
    // Generated chunks the camera has moved away from make room for nearer ones.
    if (this.generated.size > GENERATED_MAX / 2) {
      for (const i of [...this.generated.keys()].sort((a, b) => this.distance(b) - this.distance(a))) {
        if (this.generated.size <= GENERATED_MAX / 2) break
        if (!kept.has(i)) this.generated.delete(i)
      }
    }
    if (this.generator.available === 0) return
    const undrawn: number[] = []
    for (let pick = this.generator.available; pick > 0; pick--) {
      let nearest = -1
      this.chunks.forEach((chunk, i) => {
        if (chunk.drawn || this.requested.has(i) || undrawn.includes(i)) return
        if (nearest < 0 || this.distance(i) < this.distance(nearest)) nearest = i
      })
      if (nearest < 0) break
      undrawn.push(nearest)
    }
    for (const i of undrawn) {
      this.requested.add(i)
      this.generator.generate(this.seed, this.mode, i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS), 'tile').then(({ tile }) => {
        if (epoch !== this.epoch) return
        this.requested.delete(i)
        if (!this.chunks[i].drawn) this.drawTile(i, tile)
      })
    }
  }

  private drawTile(i: number, tile: Uint8Array) {
    this.overview.drawTile(i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS), tile)
    this.chunks[i].drawn = true
  }

  private draw(i: number, data: Int32Array) {
    this.overview.drawChunk(i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS), data)
    this.chunks[i].drawn = true
  }

  /** Put a chunk on the GPU, as kept or as generated; false if it isn't ready (or there's no free slot). */
  private loadChunk(i: number) {
    const chunk = this.chunks[i]
    if (chunk.reading || this.freeSlots.length === 0) return false
    const generated = chunk.data ? null : this.generated.get(i)
    const data = chunk.data ?? generated?.data
    if (!data) return false
    this.generated.delete(i)
    const slot = this.freeSlots.pop()!
    this.sim.writeChunk(this.renderer, slot, data)
    this.slots[slot] = i
    chunk.slot = slot
    chunk.serial++
    chunk.measured = false
    chunk.unsaved = false
    chunk.sums = generated?.sums ?? activitySums(data)
    chunk.live = chunk.wanted
    chunk.wanted = false
    // Woken a while ago, maybe: it has its full time awake from now.
    if (chunk.live) chunk.lastChange = this.now
    if (!chunk.drawn) this.draw(i, data)
    this.tableChanged = true
    return true
  }

  /** Take a chunk off the GPU, reading it back first if it has changed since it was loaded or last read. */
  private unload(i: number) {
    const chunk = this.chunks[i]
    if (chunk.unsaved) this.snapshot(i)
    this.slots[chunk.slot] = -1
    this.freeSlots.push(chunk.slot)
    chunk.slot = -1
    chunk.live = false
    chunk.measured = false
    this.tableChanged = true
  }

  /** Read a chunk back from its slot into `data` (as it is now; bodies' cells are left out, they're stamped again when they're back). */
  private snapshot(i: number) {
    const chunk = this.chunks[i]
    chunk.unsaved = false
    const epoch = this.epoch
    const reading = this.sim.readChunk(this.renderer, chunk.slot).then((data) => {
      if (epoch !== this.epoch) return
      for (let k = 0; k < CHUNK_CELLS; k++) if ((data[k] & 0xff) === BODY) data[k] = 0
      chunk.data = data
      chunk.dirty = true
      this.draw(i, data)
    })
    chunk.reading = reading
    reading.finally(() => {
      if (chunk.reading === reading) chunk.reading = null
    })
  }

  /** Whether every chunk a region of the world touches is on the GPU (and staying), and optionally has had its ground measured. */
  private loaded(x0: number, y0: number, x1: number, y1: number, leaving: Set<number>, measured: boolean) {
    for (const i of this.overlapping(x0, y0, x1, y1)) {
      const chunk = this.chunks[i]
      if (chunk.slot < 0 || leaving.has(i) || (measured && !chunk.measured)) return false
    }
    return true
  }

  /** Put away the bodies reaching chunks that aren't on the GPU, or are leaving it. */
  private putAwayBodies(leaving: Set<number>) {
    this.dormant.push(...this.bodies.evictWhere((x0, y0, x1, y1) => this.loaded(x0, y0, x1, y1, leaving, false)))
  }

  /** Bring back put-away bodies whose chunks are all loaded, with their ground measured. */
  private restoreBodies() {
    const none = new Set<number>()
    this.dormant = this.dormant.filter((group) => {
      const [x0, y0, x1, y1] = BodyWorld.bounds(group)
      const m = RESTORE_MARGIN
      if (!this.loaded(x0 - m, y0 - m, x1 + m, y1 + m, none, true) || !this.bodies.restore(group)) return true
      this.wakeRect(x0, y0, x1, y1)
      return false
    })
  }

  /** The chunks bodies are near (for their kernels), and those whose ground is measured: near bodies, or under put-away ones that could come back. */
  private updateBodyLists() {
    const near = new Set<number>()
    const ground = new Set<number>()
    for (const [x0, y0, x1, y1] of this.bodies.extents()) {
      for (const i of this.overlapping(x0 - BODY_SIDE_MARGIN, y0 - BODY_TOP_MARGIN, x1 + BODY_SIDE_MARGIN, y1 + BODY_BOTTOM_MARGIN)) near.add(i)
      for (const i of this.overlapping(x0 - GROUND_MARGIN, y0 - GROUND_MARGIN, x1 + GROUND_MARGIN, y1 + GROUND_MARGIN)) ground.add(i)
    }
    const none = new Set<number>()
    for (const group of this.dormant) {
      const [x0, y0, x1, y1] = BodyWorld.bounds(group)
      const m = Math.max(RESTORE_MARGIN, GROUND_MARGIN)
      if (this.loaded(x0 - m, y0 - m, x1 + m, y1 + m, none, false)) for (const i of this.overlapping(x0 - m, y0 - m, x1 + m, y1 + m)) ground.add(i)
    }
    const onGpu = (i: number) => this.chunks[i].slot >= 0
    const bodiesList = [...near].filter(onGpu).slice(0, SLOT_COUNT)
    const groundList = [...ground].filter(onGpu).slice(0, SLOT_COUNT)
    // Ground that is no longer measured may change unseen.
    for (const i of this.groundList) if (!ground.has(i)) this.chunks[i].measured = false
    const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, k) => v === b[k])
    if (!same(bodiesList, this.bodiesList) || !same(groundList, this.groundList)) this.tableChanged = true
    this.bodiesList = bodiesList
    this.groundList = groundList
  }

  /**
   * Wake a chunk (simulate it), as something has just changed in it, or might (the camera
   * is near). `changed`: it has, so it must be kept when unloaded. A chunk not on the GPU
   * is loaded, and goes live then.
   */
  private wake(cx: number, cy: number, changed = false) {
    if (!this.inWorld(cx, cy)) return
    const chunk = this.chunks[this.index(cx, cy)]
    chunk.lastChange = this.now
    if (chunk.slot < 0) {
      chunk.wanted = true
      return
    }
    if (changed) chunk.dirty = chunk.unsaved = true
    if (chunk.live) return
    chunk.live = true
    this.tableChanged = true
  }

  private sleep(i: number) {
    const chunk = this.chunks[i]
    chunk.wanted = false
    if (!chunk.live) return
    chunk.live = false
    this.tableChanged = true
  }

  /** Wake the chunks a region of the world touches (cells: min x, min y, max x, max y): something is changing there. */
  wakeRect(x0: number, y0: number, x1: number, y1: number) {
    for (const i of this.overlapping(x0, y0, x1, y1)) this.wake(i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS), true)
    this.sync()
  }

  /** Wake the chunks along a segment of the world (cells), like a laser's beam. */
  wakeSegment(x0: number, y0: number, x1: number, y1: number) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CHUNK_SIZE / 4)) + 1
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps
      const y = y0 + ((y1 - y0) * i) / steps
      this.wakeRect(x, y, x, y)
    }
  }

  /** Upload the page table and lists, if anything in them has changed. */
  sync() {
    if (!this.tableChanged) return
    this.tableChanged = false
    const table = this.table
    table.fill(0, 0, TABLE_LISTS)
    const live: number[] = []
    const resident: number[] = []
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const i = this.slots[slot]
      if (i < 0) continue
      const chunk = this.chunks[i]
      table[i] = (slot + 1) | (chunk.live ? PAGE_LIVE : 0)
      resident.push(i)
      if (!chunk.live) continue
      live.push(i)
    }
    const lists: [number, number[]][] = [
      [List.Live, live],
      [List.Resident, resident],
      [List.Ground, this.groundList],
      [List.Bodies, this.bodiesList],
    ]
    for (const [list, entries] of lists) {
      const base = TABLE_LISTS + list * LIST_STRIDE
      table[base] = entries.length
      table.set(entries, base + 1)
    }
    this.liveList = live
    const counts: ListCounts = { live: live.length, resident: resident.length, ground: this.groundList.length, bodies: this.bodiesList.length }
    this.sim.setTable(table, counts)
  }

  /** After each step: scan for activity every SCAN_EVERY_STEPS steps, and put the chunks that have gone quiet to sleep. */
  afterStep() {
    if (this.scanning || this.sim.steps - this.lastScan < SCAN_EVERY_STEPS) return
    this.lastScan = this.sim.steps
    this.scanning = true
    this.sync()
    // The scan adds up the live list as it is uploaded now: which chunks, as loaded then.
    const scanned = this.liveList.map((i) => [i, this.chunks[i].serial])
    const epoch = this.epoch
    this.sim
      .scanActivity(this.renderer, scanned.length)
      .then((sums) => epoch === this.epoch && this.applyActivity(sums, scanned))
      .finally(() => (this.scanning = false))
  }

  /** Compare each scanned chunk's sums with the last scan's: mark what changed, and wake the neighbours that changes near a side reach. */
  private applyActivity(all: Uint32Array, scanned: number[][]) {
    const now = this.now
    const size = CHUNK_SIZE
    scanned.forEach(([i, serial], n) => {
      const chunk = this.chunks[i]
      if (!chunk.live || chunk.serial !== serial) return
      const sums = all.slice(n * ACTIVITY_INTS, (n + 1) * ACTIVITY_INTS)
      const before = chunk.sums
      chunk.sums = sums
      if (!before) return
      const change = (from: number, to: number) => {
        let total = 0
        for (let k = from; k < to; k++) total += Math.abs(sums[k] - before[k])
        return total
      }
      const rows = change(0, size)
      const columns = change(size, size * 2)
      if (rows > 0 || columns > 0) chunk.dirty = chunk.unsaved = true
      if (Math.max(rows, columns) >= CHANGE_THRESHOLD) chunk.lastChange = now
      const [cx, cy] = [i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS)]
      const sides: [number, number, number][] = [
        [-1, 0, change(size, size + EDGE_CELLS)],
        [1, 0, change(size * 2 - EDGE_CELLS, size * 2)],
        [0, -1, change(0, EDGE_CELLS)],
        [0, 1, change(size - EDGE_CELLS, size)],
      ]
      for (const [dx, dy, edge] of sides) if (edge >= EDGE_THRESHOLD) this.wake(cx + dx, cy + dy)
    })
    for (const [i] of scanned) {
      const chunk = this.chunks[i]
      if (chunk.live && !this.nearCamera(i) && now - chunk.lastChange >= UNLOAD_AFTER_SECONDS) this.sleep(i)
    }
    this.sync()
  }

  /**
   * Read back the ground the bodies collide with, as last measured (SandSim.measureBodies,
   * for the ground list as it is now), into their collider. One readback at a time.
   */
  readGround() {
    if (this.readingGround) return
    this.readingGround = true
    const chunks = this.groundList.slice()
    const serials = chunks.map((i) => this.chunks[i].serial)
    const epoch = this.epoch
    this.sim
      .readSolidMask(this.renderer, chunks.length)
      .then((bits) => {
        if (epoch !== this.epoch) return
        // Only chunks still loaded as they were measured.
        const valid = chunks.map((i, n) => this.chunks[i].slot >= 0 && this.chunks[i].serial === serials[n])
        const origins = chunks.map((i): [number, number] => [(i % WORLD_CHUNKS) * CHUNK_SIZE, Math.floor(i / WORLD_CHUNKS) * CHUNK_SIZE])
        this.bodies.applyGround(bits, origins, CHUNK_SIZE, valid)
        chunks.forEach((i, n) => valid[n] && this.groundList.includes(i) && (this.chunks[i].measured = true))
      })
      .finally(() => (this.readingGround = false))
  }

  /** How each chunk is, row by row (ChunkState), for the world map. */
  states() {
    return Uint8Array.from(this.chunks, (chunk) => {
      if (chunk.slot >= 0) return chunk.live ? ChunkState.Live : ChunkState.Frozen
      return chunk.data ? ChunkState.Stored : ChunkState.Pristine
    })
  }

  /** The camera's chunk, as its neighbourhood follows it. */
  get cameraChunkIndex() {
    return this.camera
  }

  /** Bodies put away. */
  get dormantCount() {
    return this.dormant.length
  }

  /** The whole game, for saving: every chunk that has changed (those on the GPU read back now), and every body. */
  async save(camera: SaveHeader['camera']): Promise<SaveGame> {
    for (const i of this.slots) if (i >= 0 && this.chunks[i].unsaved) this.snapshot(i)
    await Promise.all(this.chunks.map((chunk) => chunk.reading))
    const kept: [number, number][] = []
    const chunks: Int32Array[] = []
    this.chunks.forEach((chunk, i) => {
      if (!chunk.data) return
      kept.push([i % WORLD_CHUNKS, Math.floor(i / WORLD_CHUNKS)])
      chunks.push(chunk.data)
    })
    const header: SaveHeader = {
      version: 1,
      chunkSize: CHUNK_SIZE,
      worldChunks: WORLD_CHUNKS,
      seed: this.seed,
      mode: this.mode,
      steps: this.sim.steps,
      paints: this.sim.paints,
      camera,
      bodies: [...this.bodies.serialize(), ...this.dormant],
      chunks: kept,
    }
    return { header, chunks }
  }

  /** Replace the world with a saved game (save.ts has checked that it fits this world); it loads around the camera from the next update. */
  load({ header, chunks }: SaveGame) {
    this.seed = header.seed
    this.mode = header.mode
    this.replace(header.bodies)
    // A saved game carries on as it was saved: it isn't settled again.
    this.settleSteps = 0
    header.chunks.forEach(([cx, cy], n) => {
      if (!this.inWorld(cx, cy) || chunks[n].length !== CHUNK_WORDS) return
      const chunk = this.chunks[this.index(cx, cy)]
      chunk.data = chunks[n]
      chunk.dirty = true
      this.draw(this.index(cx, cy), chunks[n])
    })
    this.sim.setCounters(header.steps, header.paints)
    this.lastScan = header.steps
    for (const chunk of this.chunks) chunk.lastChange = this.now
  }

  dispose() {
    this.generator.dispose()
  }
}
