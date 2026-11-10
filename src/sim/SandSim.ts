import { MeshBasicNodeMaterial, Vector2, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu'
import { instanceIndex, instancedArray, time, uint, uniform, uv, uvec2, wgsl, wgslFn } from 'three/tsl'
import { materialsWgsl, maxSpread } from './materials'
import commonWgsl from './shaders/common.wgsl?raw'
import stepWgsl from './shaders/step.wgsl?raw'
import flowWgsl from './shaders/flow.wgsl?raw'
import pressureWgsl from './shaders/pressure.wgsl?raw'
import airWgsl from './shaders/air.wgsl?raw'
import blowWgsl from './shaders/blow.wgsl?raw'
import paintWgsl from './shaders/paint.wgsl?raw'
import levelWgsl from './shaders/level.wgsl?raw'
import renderWgsl from './shaders/render.wgsl?raw'

const prelude = wgsl(materialsWgsl + commonWgsl)

const stepBlock = wgslFn(stepWgsl, [prelude])
const flowPair = wgslFn(flowWgsl, [prelude])
const pressureColumn = wgslFn(pressureWgsl, [prelude])
const airStep = wgslFn(airWgsl, [prelude])
const blowAir = wgslFn(blowWgsl, [prelude])
const paintStroke = wgslFn(paintWgsl, [prelude])
const fillLevel = wgslFn(levelWgsl, [prelude])
const sandColor = wgslFn(renderWgsl, [prelude])

/** Air cells are AIR_CELL x AIR_CELL sand cells (matches common.wgsl). */
const AIR_CELL = 4

/**
 * Static-pressure passes per step (pressure.wgsl, one GPU thread per column). Pressure
 * spreads sideways one column per pass (vertically it is instant), so more passes
 * level connected vessels sooner at the cost of GPU time. Must be even (ping-pong).
 */
export const PRESSURE_PASSES = 2

/**
 * Air steps per simulation step: more spreads pressure (e.g. into a sealed pocket being
 * pumped) faster. The air grid is 1/16 the size of the sand grid, so this is cheap.
 */
export const AIR_SUBSTEPS = 2

/** Pressure the air brush pumps in per frame (fixed point, AIR_ONE = 1024). */
const BLOW_PRESSURE = 768

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
  private readonly view = uniform(0, 'uint')
  private readonly blowPressure = uniform(0, 'int')
  private paintCount = 0
  private readonly seed = uniform(0, 'uint')
  private readonly mode = uniform(1, 'uint')
  private readonly strokeStart = uniform(new Vector2())
  private readonly strokeEnd = uniform(new Vector2())
  private readonly radius = uniform(4)
  private readonly brushMaterial = uniform(0, 'uint')
  private readonly flowOffset = uniform(0, 'uint')
  private readonly flowPass = uniform(0, 'uint')
  private stepCount = 0

  private readonly stepEven: ComputeNode
  private readonly stepOdd: ComputeNode
  /** Sideways liquid flow, one node per row parity; dispatched together each pass. */
  private readonly flowRows: ComputeNode[]
  /** Static-pressure passes, fieldA -> fieldB and back. */
  private readonly pressurePasses: ComputeNode[]
  private readonly airPhases: ComputeNode[]
  private readonly blowNode: ComputeNode
  private readonly paintNode: ComputeNode
  private readonly fillNode: ComputeNode

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

    const step = (offset: number) =>
      stepBlock({
        cells: this.cells,
        air: this.airA,
        index: instanceIndex,
        size,
        airSize,
        offset: uint(offset),
        seed: this.seed,
      }).compute(blockCount, [64])

    this.stepEven = step(0)
    this.stepOdd = step(1)

    this.pressurePasses = [
      [this.fieldA, this.fieldB],
      [this.fieldB, this.fieldA],
    ].map(([fieldIn, fieldOut]) =>
      pressureColumn({
        cells: this.cells,
        air: this.airA,
        fieldIn,
        fieldOut,
        index: instanceIndex,
        size,
        airSize,
      }).compute(width, [64]),
    )

    // Velocity update A -> B, then pressure update B -> A.
    this.airPhases = [
      [this.airA, this.airB],
      [this.airB, this.airA],
    ].map(([src, dst], phase) =>
      airStep({
        cells: this.cells,
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

    const pairCount = (Math.floor(width / 2) + 1) * Math.ceil(height / 2)
    this.flowRows = [0, 1].map((rowParity) =>
      flowPair({
        cells: this.cells,
        field: this.fieldA,
        index: instanceIndex,
        size,
        offset: this.flowOffset,
        rowParity: uint(rowParity),
        passIndex: this.flowPass,
      }).compute(pairCount, [64]),
    )

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

    this.fillNode = fillLevel({
      cells: this.cells,
      air: this.airA,
      fieldA: this.fieldA,
      fieldB: this.fieldB,
      index: instanceIndex,
      size,
      airSize,
      mode: this.mode,
    }).compute(Math.max(cellCount, airCount * 4), [64])

    this.material = new MeshBasicNodeMaterial()
    // wgslFn calls are untyped in TSL's typings; sandColor returns vec4f.
    this.material.colorNode = sandColor({
      cells: this.cells,
      air: this.airA,
      field: this.fieldA,
      uv: uv(),
      size,
      airSize,
      time,
      view: this.view,
    }) as Node<'vec4'>
  }

  /**
   * One simulation step: an air step (dynamic pressure), two Margolus passes with
   * alternating block offsets (falling, sliding, wind), PRESSURE_PASSES static-pressure
   * passes, then `maxSpread` sideways flow passes.
   * Every random choice derives from the step count, so runs are reproducible.
   */
  step(renderer: WebGPURenderer) {
    let pass = 0
    const nextSeed = () => (this.seed.value = hashSeed(this.stepCount * 64 + pass++))

    for (let s = 0; s < AIR_SUBSTEPS; s++) renderer.compute(this.airPhases)

    nextSeed()
    renderer.compute(this.stepEven)
    nextSeed()
    renderer.compute(this.stepOdd)

    for (let p = 0; p < PRESSURE_PASSES; p += 2) renderer.compute(this.pressurePasses)

    for (let flow = 0; flow < maxSpread; flow++) {
      nextSeed()
      this.flowPass.value = flow
      this.flowOffset.value = (flow + this.stepCount) & 1
      renderer.compute(this.flowRows)
    }
    this.stepCount++
  }

  /** Paint a stroke between two grid positions (cells, y down). */
  paint(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number, materialId: number) {
    this.strokeStart.value.copy(from)
    this.strokeEnd.value.copy(to)
    this.radius.value = radius
    this.brushMaterial.value = materialId
    this.seed.value = hashSeed(0x80000000 + this.paintCount++)
    renderer.compute(this.paintNode)
  }

  /** Air brush between two grid positions: pumps pressure, and blows wind along the stroke. */
  blow(renderer: WebGPURenderer, from: Vector2, to: Vector2, radius: number) {
    this.strokeStart.value.copy(from)
    this.strokeEnd.value.copy(to)
    this.radius.value = radius
    this.blowPressure.value = BLOW_PRESSURE
    renderer.compute(this.blowNode)
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
  }

  dispose() {
    this.material.dispose()
  }
}
