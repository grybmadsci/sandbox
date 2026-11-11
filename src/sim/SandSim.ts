import { MeshBasicNodeMaterial, Vector2, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu'
import { instanceIndex, instancedArray, time, uint, uniform, uv, uvec2, wgsl, wgslFn } from 'three/tsl'
import { materialsWgsl, maxSpread } from './materials'
import commonWgsl from './shaders/common.wgsl?raw'
import stepWgsl from './shaders/step.wgsl?raw'
import flowWgsl from './shaders/flow.wgsl?raw'
import pressureWgsl from './shaders/pressure.wgsl?raw'
import airWgsl from './shaders/air.wgsl?raw'
import blowWgsl from './shaders/blow.wgsl?raw'
import crumbleWgsl from './shaders/crumble.wgsl?raw'
import inspectWgsl from './shaders/inspect.wgsl?raw'
import paintWgsl from './shaders/paint.wgsl?raw'
import levelWgsl from './shaders/level.wgsl?raw'
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

const prelude = wgsl(materialsWgsl + commonWgsl)

const stepBlock = wgslFn(stepWgsl, [prelude])
const flowPair = wgslFn(flowWgsl, [prelude])
const pressureColumn = wgslFn(pressureWgsl, [prelude])
const airStep = wgslFn(airWgsl, [prelude])
const blowAir = wgslFn(blowWgsl, [prelude])
const crumbleStone = wgslFn(crumbleWgsl, [prelude])
const paintStroke = wgslFn(paintWgsl, [prelude])
const fillLevel = wgslFn(levelWgsl, [prelude])
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

/** Air cells are AIR_CELL x AIR_CELL sand cells (matches common.wgsl). */
const AIR_CELL = 4

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

/** Integer hash for deriving per-pass seeds, so runs are reproducible (no Math.random). */
const hashSeed = (n: number) => {
  let x = Math.imul(n ^ (n >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/**
 * GPU falling-sand simulation. The grid lives in a storage buffer of u32 cells,
 * with a coarse air grid (pressure and wind) beside it; WGSL kernels (via wgslFn)
 * step, paint and fill them, and `material` renders them onto a plane spanning
 * width x height world units.
 */
export class SandSim {
  readonly width: number
  readonly height: number
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
  /** The ground bodies collide with, one bit per cell (solidMask.wgsl). */
  private readonly solidBits
  readonly wordsPerColumn: number
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
  private readonly blowPressure = uniform(0, 'int')
  private paintCount = 0
  private readonly seed = uniform(0, 'uint')
  private readonly mode = uniform(1, 'uint')
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
  /** Static-pressure passes, fieldA -> fieldB and back. */
  private readonly pressurePasses: ComputeNode[]
  private readonly airPhases: ComputeNode[]
  private readonly blowNode: ComputeNode
  private readonly paintNode: ComputeNode
  private readonly fillNode: ComputeNode
  /** Stone thinner than 4 cells crumbles to sand: marking pass, then crumbling pass. */
  private readonly crumblePasses: ComputeNode[]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    const cellCount = width * height
    const blockCount = (Math.floor(width / 2) + 1) * (Math.floor(height / 2) + 1)
    const size = uvec2(width, height)
    const airWidth = Math.ceil(width / AIR_CELL)
    const airHeight = Math.ceil(height / AIR_CELL)
    const airCount = airWidth * airHeight
    const airSize = uvec2(airWidth, airHeight)

    this.cells = instancedArray(cellCount, 'uint')
    this.airA = instancedArray(airCount * 4, 'int')
    this.airB = instancedArray(airCount * 4, 'int')
    this.fieldA = instancedArray(cellCount, 'uint')
    this.fieldB = instancedArray(cellCount, 'uint')
    this.hopsA = instancedArray(cellCount, 'uint')
    this.hopsB = instancedArray(cellCount, 'uint')
    this.gauges = instancedArray(airCount * 8, 'int')
    this.wordsPerColumn = Math.ceil(height / 32)
    this.solidBits = instancedArray(width * this.wordsPerColumn, 'uint')
    this.shelterBits = instancedArray(width * this.wordsPerColumn, 'uint')

    const step = (offset: number) =>
      stepBlock({
        cells: this.cells,
        air: this.airA,
        shelter: this.shelterBits,
        index: instanceIndex,
        size,
        airSize,
        offset: uint(offset),
        seed: offset === 0 ? this.seedEven : this.seedOdd,
      }).compute(blockCount, [64])

    this.stepEven = step(0)
    this.stepOdd = step(1)

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
        index: instanceIndex,
        size,
        airSize,
      }).compute(width, [64]),
    )

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
        index: instanceIndex,
        size,
        airSize,
        phase: uint(phase),
      }).compute(airCount, [64]),
    )

    this.blowNode = blowAir({
      air: this.airA,
      index: instanceIndex,
      airSize,
      strokeStart: this.strokeStart,
      strokeEnd: this.strokeEnd,
      radius: this.radius,
      pressure: this.blowPressure,
    }).compute(airCount, [64])

    const pairCount = (Math.floor(width / 2) + 1) * Math.ceil(height / 3)
    // Pair offsets alternate between passes and steps: (pass + step count) & 1.
    this.flowPasses = Array.from({ length: maxSpread }, (_, pass) =>
      [0, 1, 2].map((rowPhase) =>
        flowPair({
          cells: this.cells,
          field: this.fieldA,
          index: instanceIndex,
          size,
          offset: uint(pass).add(this.stepParity).bitAnd(1),
          rowPhase: uint(rowPhase),
          passIndex: uint(pass),
        }).compute(pairCount, [64]),
      ),
    ).flat()

    this.paintNode = paintStroke({
      cells: this.cells,
      index: instanceIndex,
      size,
      strokeStart: this.strokeStart,
      strokeEnd: this.strokeEnd,
      radius: this.radius,
      materialId: this.brushMaterial,
      seed: this.seed,
    }).compute(cellCount, [64])

    // Uses fieldB as scratch: the first pressure pass rewrites all of it before reading.
    this.crumblePasses = [0, 1].map((phase) =>
      crumbleStone({
        cells: this.cells,
        solid: this.fieldB,
        index: instanceIndex,
        size,
        phase: uint(phase),
      }).compute(cellCount, [64]),
    )

    this.inspectNode = inspectCell({
      cells: this.cells,
      air: this.airA,
      gauges: this.gauges,
      field: this.fieldA,
      hops: this.hopsA,
      out: this.inspectOut,
      index: instanceIndex,
      size,
      airSize,
      at: this.inspectAt,
    }).compute(1, [1])

    this.stampNode = stampBodies({
      cells: this.cells,
      bodies: this.bodies,
      before: this.bodiesBefore,
      pressures: this.bodyPressures,
      forces: this.bodyForceSums,
      index: instanceIndex,
      size,
      range: uvec2(this.stampFrom, this.stampTo),
      seed: this.stampSeed,
    }).compute(Math.max(width, MAX_BODIES * BODY_FORCE_INTS), [64])

    this.bodyForcesNode = bodyForces({
      cells: this.cells,
      bodies: this.bodies,
      forces: this.bodyForceSums,
      index: instanceIndex,
      size,
    }).compute(cellCount, [64])

    this.bodyBuoyancyNode = bodyBuoyancy({
      cells: this.cells,
      bodies: this.bodies,
      forces: this.bodyForceSums,
      index: instanceIndex,
      size,
    }).compute(cellCount, [64])

    this.solidMaskNode = solidMask({
      cells: this.cells,
      bodies: this.bodies,
      mask: this.solidBits,
      index: instanceIndex,
      size,
    }).compute(width, [64])

    this.laserNode = fireLasers({
      cells: this.cells,
      lasers: this.lasers,
      hits: this.laserHits,
      index: instanceIndex,
      size,
      count: this.laserCount,
      seed: this.laserSeed,
      mine: this.laserMine,
    }).compute(MAX_LASERS * LASER_RAYS, [64])

    this.placementPasses = [0, 1].map((phase) =>
      checkPlacement({
        cells: this.cells,
        probe: this.probe,
        out: this.placeOut,
        index: instanceIndex,
        size,
        phase: uint(phase),
      }).compute(phase === 0 ? 1 : PLACE_SIDE * PLACE_SIDE, [64]),
    )

    this.shelterNode = markShelter({
      shelters: this.shelters,
      mask: this.shelterBits,
      index: instanceIndex,
      size,
      count: this.shelterCount,
    }).compute(width, [64])

    // Uses fieldB as scratch, like the crumble passes.
    this.carryPasses = [0, 1].map((phase) =>
      carryRiders({
        cells: this.cells,
        bodies: this.bodies,
        carry: this.carryList,
        riders: this.fieldB,
        index: instanceIndex,
        size,
        count: this.carryCount,
        range: uvec2(this.carryFrom, this.carryTo),
        phase: uint(phase),
      }).compute(phase === 0 ? cellCount : height, [64]),
    )

    this.fillNode = fillLevel({
      cells: this.cells,
      air: this.airA,
      fieldA: this.fieldA,
      fieldB: this.fieldB,
      gauges: this.gauges,
      index: instanceIndex,
      size,
      airSize,
      mode: this.mode,
    }).compute(Math.max(cellCount, airCount * 8), [64])

    // A step, in order: AIR_SUBSTEPS air substeps (flow update and move; the first also
    // re-measures volumes), the shelters, two Margolus passes, the static-pressure passes,
    // then the sideways flow passes.
    const [measure, move, flow] = this.airPhases
    const air = [measure, move, ...Array.from({ length: AIR_SUBSTEPS - 1 }, () => [flow, move]).flat()]
    const pressure = Array.from({ length: PRESSURE_PASSES / 2 }, () => this.pressurePasses).flat()
    this.stepNodes = [...air, this.shelterNode, this.stepEven, this.stepOdd, ...pressure, ...this.flowPasses]

    this.material = new MeshBasicNodeMaterial()
    // wgslFn calls are untyped in TSL's typings; sandColor returns vec4f.
    this.material.colorNode = sandColor({
      cells: this.cells,
      gauges: this.gauges,
      field: this.fieldA,
      hops: this.hopsA,
      bodies: this.bodies,
      lasers: this.lasers,
      laserHits: this.laserHits,
      laserCount: this.laserCount,
      uv: uv(),
      size,
      airSize,
      time,
      view: this.view,
    }) as Node<'vec4'>
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

  /** The ground bodies collide with, from the last measureBodies (column-major bits, see solidMask.wgsl). */
  async readSolidMask(renderer: WebGPURenderer) {
    return new Uint32Array(await renderer.getArrayBufferAsync(this.solidBits.value))
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
   * `data`: slot and shift, see carry.wgsl), looking at columns `from` to `to`. Run before
   * stamping the bodies where they've moved to. Queued, like the stamp.
   */
  carry(data: Int32Array, count: number, from: number, to: number) {
    if (count === 0) return
    const attribute = this.carryList.value
    ;(attribute.array as Int32Array).set(data)
    attribute.needsUpdate = true
    this.carryCount.value = count
    this.carryFrom.value = from
    this.carryTo.value = to
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

  /** Paint a stroke between two grid positions (cells, y down). */
  paint(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number, materialId: number) {
    this.strokeStart.value.copy(from)
    this.strokeEnd.value.copy(to)
    this.radius.value = radius
    this.brushMaterial.value = materialId
    this.seed.value = hashSeed(0x80000000 + this.paintCount++)
    renderer.compute(this.paintNode)
    // Painting or erasing can leave stone too thin to stand.
    renderer.compute(this.crumblePasses)
  }

  /** Air brush between two grid positions: pumps pressure, and blows wind along the stroke. */
  blow(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number) {
    this.strokeStart.value.copy(from)
    this.strokeEnd.value.copy(to)
    this.radius.value = radius
    this.blowPressure.value = BLOW_PRESSURE
    renderer.compute(this.blowNode)
  }

  /** Vacuum tool between two grid positions: takes the air out (no wind). */
  vacuum(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number) {
    this.strokeStart.value.copy(from)
    this.strokeEnd.value.copy(to)
    this.radius.value = radius
    this.blowPressure.value = -VACUUM_PRESSURE
    renderer.compute(this.blowNode)
  }

  /** Raw readout for the cell at a grid position (see inspect.wgsl; decode with decodeInspection). */
  async inspect(renderer: WebGPURenderer, at: Vector2) {
    this.inspectAt.value.copy(at)
    renderer.compute(this.inspectNode)
    return new Int32Array(await renderer.getArrayBufferAsync(this.inspectOut.value))
  }

  /** Show the pressure view (liquid and air pressure) instead of plain materials. */
  setPressureView(on: boolean) {
    this.view.value = on ? 1 : 0
  }

  /** Replace the whole grid with the starting level, or clear it, and still the air. */
  fill(renderer: WebGPURenderer, what: 'level' | 'empty') {
    // Restart the seed sequence too, so the same inputs replay identically.
    this.stepCount = 0
    this.paintCount = 0
    this.mode.value = what === 'level' ? 1 : 0
    renderer.compute(this.fillNode)
    renderer.compute(this.crumblePasses)
    // The fill wiped the bodies' cells: forget where they were stamped, so the next stamp
    // (which skips columns where nothing changed) draws them all again.
    ;(this.bodies.value.array as Float32Array).fill(0)
  }

  dispose() {
    this.material.dispose()
  }
}
