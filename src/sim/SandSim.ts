import { MeshBasicNodeMaterial, Vector2, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu'
import { instanceIndex, instancedArray, time, uint, uniform, uv, uvec2, wgsl, wgslFn } from 'three/tsl'
import { materialsWgsl, maxSpread } from './materials'
import { AIR_CELL, CHUNK_CELLS, CHUNK_SIZE, CHUNK_WORDS, SLOT_COUNT, TABLE_WORDS, WORLD_SIZE, chunksWgsl } from '../world/config'
import commonWgsl from './shaders/common.wgsl?raw'
import stepWgsl from './shaders/step.wgsl?raw'
import flowWgsl from './shaders/flow.wgsl?raw'
import pressureWgsl from './shaders/pressure.wgsl?raw'
import pressureSplitWgsl from './shaders/pressureSplit.wgsl?raw'
import airWgsl from './shaders/air.wgsl?raw'
import blowWgsl from './shaders/blow.wgsl?raw'
import crumbleWgsl from './shaders/crumble.wgsl?raw'
import inspectWgsl from './shaders/inspect.wgsl?raw'
import paintWgsl from './shaders/paint.wgsl?raw'
import chunkWgsl from './shaders/chunk.wgsl?raw'
import activityWgsl from './shaders/activity.wgsl?raw'
import renderWgsl from './shaders/render.wgsl?raw'
import stampWgsl from './shaders/stamp.wgsl?raw'
import bodyForcesWgsl from './shaders/bodyForces.wgsl?raw'
import bodyBuoyancyWgsl from './shaders/bodyBuoyancy.wgsl?raw'
import solidMaskWgsl from './shaders/solidMask.wgsl?raw'
import laserWgsl from './shaders/laser.wgsl?raw'
import placementWgsl from './shaders/placement.wgsl?raw'
import carryWgsl from './shaders/carry.wgsl?raw'
import shelterWgsl from './shaders/shelter.wgsl?raw'
import { BODY_FLOATS, BODY_FORCE_INTS, MAX_BODIES, SHELTER_FLOATS } from './bodies'
import { LASER_FLOATS, LASER_RAYS, MAX_LASERS } from './objects'

const prelude = wgsl(materialsWgsl + chunksWgsl + commonWgsl)

const stepBlock = wgslFn(stepWgsl, [prelude])
const flowPair = wgslFn(flowWgsl, [prelude])
const pressureColumn = wgslFn(pressureWgsl, [prelude])
const pressureSplit = wgslFn(pressureSplitWgsl, [prelude])
const airStep = wgslFn(airWgsl, [prelude])
const blowAir = wgslFn(blowWgsl, [prelude])
const crumbleStone = wgslFn(crumbleWgsl, [prelude])
const paintStroke = wgslFn(paintWgsl, [prelude])
const chunkTransfer = wgslFn(chunkWgsl, [prelude])
const scanActivity = wgslFn(activityWgsl, [prelude])
const sandColor = wgslFn(renderWgsl, [prelude])
const inspectCell = wgslFn(inspectWgsl, [prelude])
const stampBodies = wgslFn(stampWgsl, [prelude])
const bodyForces = wgslFn(bodyForcesWgsl, [prelude])
const bodyBuoyancy = wgslFn(bodyBuoyancyWgsl, [prelude])
const solidMask = wgslFn(solidMaskWgsl, [prelude])
const fireLasers = wgslFn(laserWgsl, [prelude])
const checkPlacement = wgslFn(placementWgsl, [prelude])
const carryRiders = wgslFn(carryWgsl, [prelude])
const markShelter = wgslFn(shelterWgsl, [prelude])

/** Cells across the bounds placement.wgsl checks (its PLACE_SIDE). */
const PLACE_SIDE = 132

/**
 * Static-pressure passes per step (pressure.wgsl, one GPU thread per column). Pressure
 * spreads sideways one column per pass (vertically it is instant), so more passes
 * level connected vessels sooner at the cost of GPU time. Must be even (ping-pong).
 */
export const PRESSURE_PASSES = 2

/**
 * Air substeps per simulation step (AIR_SUBSTEPS in common.wgsl must match). Still air
 * is stiff, so pressure must even out within a step or two: each substep carries
 * pressure waves about half an air cell. The air grid is 1/16 the size of the sand
 * grid, and only the first substep re-reads the sand cells, so this stays cheap.
 */
export const AIR_SUBSTEPS = 16

/** Pressure the air brush pumps in per frame (AIR_ROW = 256 per row of liquid). */
const BLOW_PRESSURE = 768

/** Air the vacuum tool takes out per frame: an eighth of an atmosphere (AIR_AMBIENT / 8). */
const VACUUM_PRESSURE = 32768

/** Sums per live chunk that the activity scan fills (activity.wgsl): one per row, then one per column. */
export const ACTIVITY_INTS = CHUNK_SIZE * 2

/** Ground mask words per chunk (solidMask.wgsl): MASK_WORDS per column. */
export const GROUND_WORDS = (CHUNK_SIZE * CHUNK_SIZE) / 32

/** Air cells in a chunk (common.wgsl AIR_SIDE squared). */
const CHUNK_AIR = (CHUNK_SIZE / AIR_CELL) ** 2

/** How many chunks are in each of the page table's lists (world/config.ts List), as SandSim.setTable takes them. */
export type ListCounts = { live: number; resident: number; ground: number; bodies: number }

/** Invocations per chunk of the step's and the sideways flow's passes (BLOCKS_ACROSS in step.wgsl, PAIRS_ACROSS and PHASE_ROWS in flow.wgsl). */
const STEP_BLOCKS = (CHUNK_SIZE / 2 + 1) ** 2
const FLOW_PAIRS = (CHUNK_SIZE / 2 + 1) * Math.ceil(CHUNK_SIZE / 3)

/** Integer hash for deriving per-pass seeds, so runs are reproducible (no Math.random). */
const hashSeed = (n: number) => {
  let x = Math.imul(n ^ (n >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/**
 * GPU falling-sand simulation. The grid lives in storage buffers of u32 cells, with a
 * coarse air grid (pressure and wind) beside it; WGSL kernels (via wgslFn) step and paint
 * them, and `material` renders them onto a plane spanning the world, one world unit per cell.
 *
 * The world is in chunks, and the buffers hold SLOT_COUNT of them, a slot each: chunks are
 * copied in and out of slots (`writeChunk`, `readChunk`), and the page table (`setTable`,
 * see world/config.ts) says which chunk is in which slot and which are live (simulated).
 * The rest hold still, and are walls to the live ones. world/ChunkManager.ts decides.
 */
export class SandSim {
  readonly material: MeshBasicNodeMaterial

  private readonly cells
  /** Air grid, ping-ponged within each air step; `airA` holds the current state. */
  private readonly airA
  private readonly airB
  /** Pressure field, ping-ponged by the pressure passes; `fieldA` holds the current state. */
  private readonly fieldA
  private readonly fieldB
  /** How many columns each cell's head has come, ping-ponged with the field. */
  private readonly hopsA
  private readonly hopsB
  /** The inspect tool's readout for one cell (see inspect.wgsl), read back to the CPU. */
  private readonly inspectOut = instancedArray(16, 'int')
  private readonly inspectAt = uniform(new Vector2())
  private readonly inspectNode: ComputeNode
  /** Each air cell's gauge pressure filtered for liquids, and its recent net outflow (8 per air cell, see GAUGE_FAST). */
  private readonly gauges
  /** Rigid bodies (written by bodies.ts, see common.wgsl), and the forces on them. */
  private readonly bodies = instancedArray(MAX_BODIES * BODY_FLOATS, 'float')
  /** The bodies as last stamped, so the stamp knows which rows they may have left (stamp.wgsl). */
  private readonly bodiesBefore = instancedArray(MAX_BODIES * BODY_FLOATS, 'float')
  private readonly bodyForceSums = instancedArray(MAX_BODIES * BODY_FORCE_INTS, 'int').toAtomic()
  /** How hard each body presses on the ground (bodies.ts), against powders' bearing strength (stamp.wgsl). */
  private readonly bodyPressures = instancedArray(MAX_BODIES, 'float')
  /** Columns the stamp pass rewrites: where bodies are, or were last time. */
  private readonly stampFrom = uniform(0, 'uint')
  private readonly stampTo = uniform(0, 'uint')
  /** The ground bodies collide with, one bit per cell of the chunks bodies are near (solidMask.wgsl). */
  private readonly solidBits
  private readonly stampNode: ComputeNode
  private readonly bodyForcesNode: ComputeNode
  private readonly bodyBuoyancyNode: ComputeNode
  private readonly solidMaskNode: ComputeNode
  /** Mining lasers (written by bodies.ts, see common.wgsl), and how far each ray got (laser.wgsl). */
  private readonly lasers = instancedArray(MAX_LASERS * LASER_FLOATS, 'float')
  private readonly laserHits = instancedArray(MAX_LASERS * LASER_RAYS, 'float')
  private readonly laserCount = uniform(0, 'uint')
  private readonly laserMine = uniform(0, 'uint')
  private readonly laserNode: ComputeNode
  /** A body to place, and how many cells would block it (placement.wgsl). */
  private readonly probe = instancedArray(BODY_FLOATS, 'float')
  private readonly placeOut = instancedArray(4, 'int').toAtomic()
  private readonly placementPasses: ComputeNode[]
  /** Bodies that moved sideways (slot, shift), for carrying what rests on them (carry.wgsl). */
  private readonly carryList = instancedArray(MAX_BODIES * 2, 'int')
  private readonly carryCount = uniform(0, 'uint')
  private readonly carryFrom = uniform(0, 'uint')
  private readonly carryTo = uniform(0, 'uint')
  private readonly carryPasses: ComputeNode[]
  /** Shelters bodies declare (bodies.ts packShelters), and the cells in them, out of the wind: one bit per cell (shelter.wgsl). */
  private readonly shelters = instancedArray(MAX_BODIES * SHELTER_FLOATS, 'float')
  private readonly shelterCount = uniform(0, 'uint')
  private readonly shelterBits
  private readonly shelterNode: ComputeNode
  private readonly view = uniform(0, 'uint')
  /** The page table and the lists of chunks the kernels run over (world/config.ts). */
  private readonly table = instancedArray(TABLE_WORDS, 'uint')
  /** One chunk's state going in or out (chunk.wgsl), and which slot. */
  private readonly chunkIn = instancedArray(CHUNK_WORDS, 'int')
  private readonly chunkOut = instancedArray(CHUNK_WORDS, 'int')
  private readonly chunkSlot = uniform(0, 'uint')
  private readonly chunkWriteNode: ComputeNode
  private readonly chunkReadNode: ComputeNode
  /** What the activity scan adds up (activity.wgsl). */
  private readonly activity = instancedArray(SLOT_COUNT * ACTIVITY_INTS, 'uint').toAtomic()
  private readonly activityPasses: ComputeNode[]
  private readonly blowPressure = uniform(0, 'int')
  /** The bounds a paint or blow stroke covers (first cell or air cell, and how many across). */
  private readonly boxX = uniform(0, 'int')
  private readonly boxY = uniform(0, 'int')
  private readonly boxWidth = uniform(1, 'int')
  /** Rows carry.wgsl moves riders in. */
  private readonly carryTop = uniform(0, 'uint')
  private readonly carryBottom = uniform(0, 'uint')
  private paintCount = 0
  private readonly seed = uniform(0, 'uint')
  private readonly strokeStart = uniform(new Vector2())
  private readonly strokeEnd = uniform(new Vector2())
  private readonly radius = uniform(4)
  private readonly brushMaterial = uniform(0, 'uint')
  /** Per step: the seeds of the two Margolus passes, and the step count's parity (flow offsets). */
  private readonly seedEven = uniform(0, 'uint')
  private readonly seedOdd = uniform(0, 'uint')
  private readonly stepParity = uniform(0, 'uint')
  private stepCount = 0
  /**
   * Every dispatch of a step, in order, run as one compute call: each call is a command
   * buffer submitted on its own, which costs far more than most of these dispatches, so
   * nothing in a step may depend on uniforms changing between them.
   */
  private readonly stepNodes: ComputeNode[]
  /**
   * Dispatches queued before the next step (carry, stamp, lasers), submitted with it in
   * the same call; `flush` submits them without a step (while paused).
   */
  private pending: ComputeNode[] = []
  /** Seeds of the stamp and the lasers, which are queued together (so they can't share `seed`). */
  private readonly stampSeed = uniform(0, 'uint')
  private readonly laserSeed = uniform(0, 'uint')

  private readonly stepEven: ComputeNode
  private readonly stepOdd: ComputeNode
  /** Sideways liquid flow: `maxSpread` passes, each three nodes (rows modulo 3). */
  private readonly flowPasses: ComputeNode[]
  /** Static-pressure passes, fieldA -> fieldB and back, and where their walks start (pressureSplit.wgsl, run before each). */
  private readonly pressurePasses: ComputeNode[]
  private readonly splits = instancedArray(SLOT_COUNT * CHUNK_SIZE, 'uint')
  private readonly splitNode: ComputeNode
  private readonly airPhases: ComputeNode[]
  private readonly blowNode: ComputeNode
  private readonly paintNode: ComputeNode
  /** Stone thinner than 4 cells crumbles to sand: marking pass, then crumbling pass. */
  private readonly crumblePasses: ComputeNode[]

  constructor() {
    const cellCount = SLOT_COUNT * CHUNK_CELLS
    const airCount = SLOT_COUNT * CHUNK_AIR
    const maskWords = SLOT_COUNT * GROUND_WORDS
    const table = this.table

    this.cells = instancedArray(cellCount, 'uint')
    this.airA = instancedArray(airCount * 4, 'int')
    this.airB = instancedArray(airCount * 4, 'int')
    this.fieldA = instancedArray(cellCount, 'uint')
    this.fieldB = instancedArray(cellCount, 'uint')
    this.hopsA = instancedArray(cellCount, 'uint')
    this.hopsB = instancedArray(cellCount, 'uint')
    this.gauges = instancedArray(airCount * 8, 'int')
    this.solidBits = instancedArray(maskWords, 'uint')
    this.shelterBits = instancedArray(maskWords, 'uint')
    // Kernels over lists of chunks start with room for every slot; setTable sets how many
    // invocations they really dispatch.
    const slots = SLOT_COUNT

    const step = (offset: number) =>
      stepBlock({
        cells: this.cells,
        air: this.airA,
        shelter: this.shelterBits,
        table,
        index: instanceIndex,
        offset: uint(offset),
        seed: offset === 0 ? this.seedEven : this.seedOdd,
      }).compute(slots * STEP_BLOCKS, [64])

    this.stepEven = step(0)
    this.stepOdd = step(1)

    // In small workgroups: each column's walk is long and serial, so they spread better over the GPU.
    this.pressurePasses = [
      [this.fieldA, this.fieldB, this.hopsA, this.hopsB],
      [this.fieldB, this.fieldA, this.hopsB, this.hopsA],
    ].map(([fieldIn, fieldOut, hopsIn, hopsOut]) =>
      pressureColumn({
        cells: this.cells,
        air: this.airA,
        gauges: this.gauges,
        fieldIn,
        fieldOut,
        hopsIn,
        hopsOut,
        splits: this.splits,
        table,
        index: instanceIndex,
      }).compute(slots * CHUNK_SIZE, [16]),
    )
    this.splitNode = pressureSplit({ cells: this.cells, splits: this.splits, table, index: instanceIndex }).compute(slots * CHUNK_SIZE, [64])

    // Flow update A -> B (phase 0 also re-measures volumes, phase 2 doesn't), then
    // moving the air B -> A (phase 1).
    this.airPhases = [
      [this.airA, this.airB],
      [this.airB, this.airA],
      [this.airA, this.airB],
    ].map(([src, dst], phase) =>
      airStep({
        cells: this.cells,
        gauges: this.gauges,
        src,
        dst,
        table,
        index: instanceIndex,
        phase: uint(phase),
      }).compute(slots * CHUNK_AIR, [64]),
    )

    const box = { boxX: this.boxX, boxY: this.boxY, boxWidth: this.boxWidth }
    this.blowNode = blowAir({
      air: this.airA,
      table,
      index: instanceIndex,
      ...box,
      strokeStart: this.strokeStart,
      strokeEnd: this.strokeEnd,
      radius: this.radius,
      pressure: this.blowPressure,
    }).compute(1, [64])

    // Pair offsets alternate between passes and steps: (pass + step count) & 1.
    this.flowPasses = Array.from({ length: maxSpread }, (_, pass) =>
      [0, 1, 2].map((rowPhase) =>
        flowPair({
          cells: this.cells,
          field: this.fieldA,
          table,
          index: instanceIndex,
          offset: uint(pass).add(this.stepParity).bitAnd(1),
          rowPhase: uint(rowPhase),
          passIndex: uint(pass),
        }).compute(slots * FLOW_PAIRS, [64]),
      ),
    ).flat()

    this.paintNode = paintStroke({
      cells: this.cells,
      table,
      index: instanceIndex,
      ...box,
      strokeStart: this.strokeStart,
      strokeEnd: this.strokeEnd,
      radius: this.radius,
      materialId: this.brushMaterial,
      seed: this.seed,
    }).compute(1, [64])

    // Uses fieldB as scratch: the first pressure pass rewrites all of the live chunks' before reading.
    this.crumblePasses = [0, 1].map((phase) =>
      crumbleStone({
        cells: this.cells,
        solid: this.fieldB,
        table,
        index: instanceIndex,
        phase: uint(phase),
      }).compute(slots * CHUNK_CELLS, [64]),
    )

    this.inspectNode = inspectCell({
      cells: this.cells,
      air: this.airA,
      gauges: this.gauges,
      field: this.fieldA,
      hops: this.hopsA,
      out: this.inspectOut,
      table,
      index: instanceIndex,
      at: this.inspectAt,
    }).compute(1, [1])

    this.stampNode = stampBodies({
      cells: this.cells,
      bodies: this.bodies,
      before: this.bodiesBefore,
      pressures: this.bodyPressures,
      forces: this.bodyForceSums,
      table,
      index: instanceIndex,
      range: uvec2(this.stampFrom, this.stampTo),
      seed: this.stampSeed,
    }).compute(MAX_BODIES * BODY_FORCE_INTS, [64])

    this.bodyForcesNode = bodyForces({
      cells: this.cells,
      bodies: this.bodies,
      forces: this.bodyForceSums,
      table,
      index: instanceIndex,
    }).compute(slots * CHUNK_CELLS, [64])

    this.bodyBuoyancyNode = bodyBuoyancy({
      cells: this.cells,
      bodies: this.bodies,
      forces: this.bodyForceSums,
      table,
      index: instanceIndex,
    }).compute(slots * CHUNK_CELLS, [64])

    this.solidMaskNode = solidMask({
      cells: this.cells,
      bodies: this.bodies,
      mask: this.solidBits,
      table,
      index: instanceIndex,
    }).compute(slots * CHUNK_SIZE, [64])

    this.laserNode = fireLasers({
      cells: this.cells,
      lasers: this.lasers,
      hits: this.laserHits,
      table,
      index: instanceIndex,
      count: this.laserCount,
      seed: this.laserSeed,
      mine: this.laserMine,
    }).compute(MAX_LASERS * LASER_RAYS, [64])

    this.placementPasses = [0, 1].map((phase) =>
      checkPlacement({
        cells: this.cells,
        probe: this.probe,
        out: this.placeOut,
        table,
        index: instanceIndex,
        phase: uint(phase),
      }).compute(phase === 0 ? 1 : PLACE_SIDE * PLACE_SIDE, [64]),
    )

    this.shelterNode = markShelter({
      shelters: this.shelters,
      mask: this.shelterBits,
      table,
      index: instanceIndex,
      count: this.shelterCount,
    }).compute(slots * CHUNK_SIZE, [64])

    // Uses fieldB as scratch, like the crumble passes.
    this.carryPasses = [0, 1].map((phase) =>
      carryRiders({
        cells: this.cells,
        bodies: this.bodies,
        carry: this.carryList,
        riders: this.fieldB,
        table,
        index: instanceIndex,
        count: this.carryCount,
        range: uvec2(this.carryFrom, this.carryTo),
        rows: uvec2(this.carryTop, this.carryBottom),
        phase: uint(phase),
      }).compute(phase === 0 ? slots * CHUNK_CELLS : 1, [64]),
    )

    const [chunkWriteNode, chunkReadNode] = [
      [this.chunkIn, 1],
      [this.chunkOut, 0],
    ].map(([data, write]) =>
      chunkTransfer({
        cells: this.cells,
        air: this.airA,
        gauges: this.gauges,
        data,
        field: this.fieldA,
        index: instanceIndex,
        slot: this.chunkSlot,
        write: uint(write as number),
      }).compute(CHUNK_WORDS, [64]),
    )
    this.chunkWriteNode = chunkWriteNode
    this.chunkReadNode = chunkReadNode

    this.activityPasses = [0, 1].map((phase) =>
      scanActivity({
        cells: this.cells,
        sums: this.activity,
        table,
        index: instanceIndex,
        phase: uint(phase),
      }).compute(phase === 0 ? SLOT_COUNT * ACTIVITY_INTS : slots * CHUNK_CELLS, [64]),
    )

    // A step, in order: AIR_SUBSTEPS air substeps (flow update and move; the first also
    // re-measures volumes), the shelters, two Margolus passes, the static-pressure passes,
    // then the sideways flow passes.
    const [measure, move, flow] = this.airPhases
    const air = [measure, move, ...Array.from({ length: AIR_SUBSTEPS - 1 }, () => [flow, move]).flat()]
    const pressure = Array.from({ length: PRESSURE_PASSES / 2 }, () => this.pressurePasses.flatMap((pass) => [this.splitNode, pass])).flat()
    this.stepNodes = [...air, this.shelterNode, this.stepEven, this.stepOdd, ...pressure, ...this.flowPasses]

    this.material = new MeshBasicNodeMaterial()
    // Clear where a chunk has no slot, for the overview behind.
    this.material.transparent = true
    // wgslFn calls are untyped in TSL's typings; sandColor returns vec4f.
    this.material.colorNode = sandColor({
      cells: this.cells,
      gauges: this.gauges,
      field: this.fieldA,
      hops: this.hopsA,
      bodies: this.bodies,
      lasers: this.lasers,
      laserHits: this.laserHits,
      table,
      laserCount: this.laserCount,
      uv: uv(),
      time,
      view: this.view,
    }) as Node<'vec4'>
  }

  /**
   * Upload the page table and lists (TABLE_WORDS words, see world/config.ts), and how many
   * chunks are in each list: the kernels dispatch that many chunks' worth of invocations.
   */
  setTable(data: Uint32Array, counts: ListCounts) {
    const attribute = this.table.value
    ;(attribute.array as Uint32Array).set(data)
    attribute.needsUpdate = true
    const size = (node: ComputeNode, n: number) => void (node.count = Math.max(1, n))
    for (const node of [this.stepEven, this.stepOdd]) size(node, counts.live * STEP_BLOCKS)
    for (const node of this.flowPasses) size(node, counts.live * FLOW_PAIRS)
    for (const node of this.airPhases) size(node, counts.live * CHUNK_AIR)
    for (const node of [...this.pressurePasses, this.splitNode]) size(node, counts.live * CHUNK_SIZE)
    size(this.shelterNode, counts.live * CHUNK_SIZE)
    size(this.activityPasses[1], counts.live * CHUNK_CELLS)
    size(this.crumblePasses[0], counts.resident * CHUNK_CELLS)
    size(this.crumblePasses[1], counts.live * CHUNK_CELLS)
    size(this.bodyForcesNode, counts.bodies * CHUNK_CELLS)
    size(this.bodyBuoyancyNode, counts.bodies * CHUNK_CELLS)
    size(this.carryPasses[0], counts.bodies * CHUNK_CELLS)
    size(this.solidMaskNode, counts.ground * CHUNK_SIZE)
  }

  /** Steps taken since the world was generated (or as loaded): the simulation's clock. */
  get steps() {
    return this.stepCount
  }

  /** Restore the step and paint counts the seeds derive from (loading a saved game). */
  setCounters(steps: number, paints: number) {
    this.stepCount = steps
    this.paintCount = paints
  }

  get paints() {
    return this.paintCount
  }

  /** Write a chunk's state (CHUNK_WORDS words, see world/config.ts) into a slot. */
  writeChunk(renderer: WebGPURenderer, slot: number, data: Int32Array) {
    const attribute = this.chunkIn.value
    ;(attribute.array as Int32Array).set(data)
    attribute.needsUpdate = true
    this.chunkSlot.value = slot
    renderer.compute(this.chunkWriteNode)
  }

  /**
   * Read a slot's chunk back, as it is now (CHUNK_WORDS words, see world/config.ts). The
   * copy is queued at once, so the slot can take another chunk straight away.
   */
  async readChunk(renderer: WebGPURenderer, slot: number) {
    this.chunkSlot.value = slot
    renderer.compute(this.chunkReadNode)
    return new Int32Array(await renderer.getArrayBufferAsync(this.chunkOut.value))
  }

  /** Add up what each live chunk holds along its rows and columns: ACTIVITY_INTS per chunk, in the live list's order (activity.wgsl). */
  async scanActivity(renderer: WebGPURenderer, live: number) {
    renderer.compute(this.activityPasses)
    return new Uint32Array(await renderer.getArrayBufferAsync(this.activity.value, null, 0, Math.max(live, 1) * ACTIVITY_INTS * 4))
  }

  /**
   * One simulation step: AIR_SUBSTEPS air substeps (dynamic pressure), marking the cells
   * in shelters as out of the wind, two Margolus passes with
   * alternating block offsets (falling, sliding, wind), PRESSURE_PASSES static-pressure
   * passes, then `maxSpread` sideways flow passes.
   * Every random choice derives from the step count, so runs are reproducible.
   */
  step(renderer: WebGPURenderer) {
    this.seedEven.value = hashSeed(this.stepCount * 64)
    this.seedOdd.value = hashSeed(this.stepCount * 64 + 1)
    this.stepParity.value = this.stepCount & 1
    renderer.compute([...this.pending, ...this.stepNodes])
    this.pending = []
    this.stepCount++
  }

  /** Submit what's queued for the next step (carry, stamp, lasers) without stepping, as while paused. */
  flush(renderer: WebGPURenderer) {
    if (this.pending.length === 0) return
    renderer.compute(this.pending)
    this.pending = []
  }

  /**
   * Upload the rigid bodies (BODY_FLOATS per slot) and how hard each presses on the
   * ground, and stamp them into the grid, rewriting columns `from` to `to` (exclusive).
   * Also clears the force sums. Queued: submitted with the next step, or by `flush`.
   */
  stampBodies(data: Float32Array, pressures: Float32Array, from: number, to: number) {
    const attribute = this.bodies.value
    const before = this.bodiesBefore.value
    ;(before.array as Float32Array).set(attribute.array as Float32Array)
    before.needsUpdate = true
    ;(attribute.array as Float32Array).set(data)
    attribute.needsUpdate = true
    const pressure = this.bodyPressures.value
    ;(pressure.array as Float32Array).set(pressures)
    pressure.needsUpdate = true
    this.stampFrom.value = from
    this.stampTo.value = to
    this.stampNode.count = Math.max(to - from, MAX_BODIES * BODY_FORCE_INTS)
    this.stampSeed.value = hashSeed(this.stepCount * 64 + 62)
    this.pending.push(this.stampNode)
  }

  /**
   * Pack the ground bodies collide with, and (when there are any bodies) sum up the
   * forces on them since the last stamp.
   */
  measureBodies(renderer: WebGPURenderer, forces: boolean) {
    renderer.compute(forces ? [this.bodyForcesNode, this.bodyBuoyancyNode, this.solidMaskNode] : this.solidMaskNode)
  }

  /** Forces on the bodies, from the last measureBodies (BODY_FORCE_INTS per slot, see common.wgsl). */
  async readBodyForces(renderer: WebGPURenderer) {
    return new Int32Array(await renderer.getArrayBufferAsync(this.bodyForceSums.value))
  }

  /** The ground bodies collide with, from the last measureBodies: GROUND_WORDS per chunk of the ground list (`chunks` of them), in its order (solidMask.wgsl). */
  async readSolidMask(renderer: WebGPURenderer, chunks: number) {
    return new Uint32Array(await renderer.getArrayBufferAsync(this.solidBits.value, null, 0, Math.max(chunks, 1) * GROUND_WORDS * 4))
  }

  /** Upload the shelters (`count` of them, SHELTER_FLOATS each, see shelter.wgsl), for the next steps. */
  setShelters(data: Float32Array, count: number) {
    this.shelterCount.value = count
    if (count === 0) return
    const attribute = this.shelters.value
    ;(attribute.array as Float32Array).set(data)
    attribute.needsUpdate = true
  }

  /**
   * Carry what rests on the bodies that moved sideways along with them (`count` of them in
   * `data`: slot and shift, see carry.wgsl), looking at columns `from` to `to` and rows `top`
   * to `bottom` (exclusive). Run before stamping the bodies where they've moved to. Queued,
   * like the stamp.
   */
  carry(data: Int32Array, count: number, from: number, to: number, top: number, bottom: number) {
    if (count === 0 || to <= from || bottom <= top) return
    const attribute = this.carryList.value
    ;(attribute.array as Int32Array).set(data)
    attribute.needsUpdate = true
    this.carryCount.value = count
    this.carryFrom.value = from
    this.carryTo.value = to
    this.carryTop.value = top
    this.carryBottom.value = bottom
    this.carryPasses[1].count = bottom - top
    this.pending.push(...this.carryPasses)
  }

  /**
   * Upload the mining lasers (`count` of them, LASER_FLOATS each) and fire them: they
   * decompose the stone they hit into sand when `mine`, else only trace their beams
   * (for drawing while paused). Run after stamping the bodies, before a step. Queued,
   * like the stamp.
   */
  fireLasers(data: Float32Array, count: number, mine: boolean) {
    this.laserCount.value = count
    if (count === 0) return
    const attribute = this.lasers.value
    ;(attribute.array as Float32Array).set(data)
    attribute.needsUpdate = true
    this.laserMine.value = mine ? 1 : 0
    this.laserSeed.value = hashSeed(this.stepCount * 64 + 63)
    this.pending.push(this.laserNode)
  }

  /**
   * How many cells would block a placeable object (one body, BODY_FLOATS floats, see
   * placement.wgsl); 0 when it fits.
   */
  async checkPlacement(renderer: WebGPURenderer, data: Float32Array) {
    const attribute = this.probe.value
    ;(attribute.array as Float32Array).set(data)
    attribute.needsUpdate = true
    renderer.compute(this.placementPasses)
    return new Int32Array(await renderer.getArrayBufferAsync(this.placeOut.value))[0]
  }

  /** Crumble stone thinner than 4 cells to sand (crumble.wgsl), after painting or mining. */
  crumble(renderer: WebGPURenderer) {
    renderer.compute(this.crumblePasses)
  }

  /** Set a stroke between two world positions (cells, y down), and the bounds its kernel runs over, in units of `cell` cells (sand or air cells). */
  private stroke(node: ComputeNode, from: Vector2, to: Vector2, radius: number, cell: number) {
    this.strokeStart.value.copy(from)
    this.strokeEnd.value.copy(to)
    this.radius.value = radius
    const reach = Math.max(radius, cell) + 1
    const lo = (v: number) => Math.max(0, Math.floor((v - reach) / cell))
    const hi = (v: number) => Math.min(WORLD_SIZE / cell - 1, Math.floor((v + reach) / cell))
    const [x0, y0] = [lo(Math.min(from.x, to.x)), lo(Math.min(from.y, to.y))]
    const [x1, y1] = [hi(Math.max(from.x, to.x)), hi(Math.max(from.y, to.y))]
    this.boxX.value = x0
    this.boxY.value = y0
    this.boxWidth.value = Math.max(x1 - x0 + 1, 1)
    node.count = Math.max((x1 - x0 + 1) * (y1 - y0 + 1), 1)
  }

  /** Paint a stroke between two world positions (cells, y down). */
  paint(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number, materialId: number) {
    this.stroke(this.paintNode, from, to, radius, 1)
    this.brushMaterial.value = materialId
    this.seed.value = hashSeed(0x80000000 + this.paintCount++)
    renderer.compute(this.paintNode)
    // Painting or erasing can leave stone too thin to stand.
    renderer.compute(this.crumblePasses)
  }

  /** Air brush between two world positions: pumps pressure, and blows wind along the stroke. */
  blow(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number) {
    this.stroke(this.blowNode, from, to, radius, AIR_CELL)
    this.blowPressure.value = BLOW_PRESSURE
    renderer.compute(this.blowNode)
  }

  /** Vacuum tool between two world positions: takes the air out (no wind). */
  vacuum(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number) {
    this.stroke(this.blowNode, from, to, radius, AIR_CELL)
    this.blowPressure.value = -VACUUM_PRESSURE
    renderer.compute(this.blowNode)
  }

  /** Raw readout for the cell at a world position (see inspect.wgsl; decode with decodeInspection). */
  async inspect(renderer: WebGPURenderer, at: Vector2) {
    this.inspectAt.value.copy(at)
    renderer.compute(this.inspectNode)
    return new Int32Array(await renderer.getArrayBufferAsync(this.inspectOut.value))
  }

  /** Show the pressure view (liquid and air pressure) instead of plain materials. */
  setPressureView(on: boolean) {
    this.view.value = on ? 1 : 0
  }

  /** Start over, for a new world: restart the seed sequence (so the same inputs replay identically), and forget where bodies were stamped. */
  clear() {
    this.stepCount = 0
    this.paintCount = 0
    // A new world's chunks are written in without bodies: the next stamp (which skips
    // columns where nothing changed) must draw them all again.
    ;(this.bodies.value.array as Float32Array).fill(0)
  }

  dispose() {
    this.material.dispose()
  }
}
