import { MeshBasicNodeMaterial, Vector2, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu'
import { instanceIndex, instancedArray, time, uint, uniform, uv, uvec2, wgsl, wgslFn } from 'three/tsl'
import { materialsWgsl, maxSpread } from './materials'
import commonWgsl from './shaders/common.wgsl?raw'
import stepWgsl from './shaders/step.wgsl?raw'
import flowWgsl from './shaders/flow.wgsl?raw'
import paintWgsl from './shaders/paint.wgsl?raw'
import levelWgsl from './shaders/level.wgsl?raw'
import renderWgsl from './shaders/render.wgsl?raw'

const prelude = wgsl(materialsWgsl + commonWgsl)

const stepBlock = wgslFn(stepWgsl, [prelude])
const flowPair = wgslFn(flowWgsl, [prelude])
const paintStroke = wgslFn(paintWgsl, [prelude])
const fillLevel = wgslFn(levelWgsl, [prelude])
const sandColor = wgslFn(renderWgsl, [prelude])

const randomSeed = () => (Math.random() * 0x100000000) >>> 0

/**
 * GPU falling-sand simulation. The grid lives in a single storage buffer of u32
 * cells; WGSL kernels (via wgslFn) step, paint and fill it, and `material`
 * renders it onto a plane spanning width x height world units.
 */
export class SandSim {
  readonly width: number
  readonly height: number
  readonly material: MeshBasicNodeMaterial

  private readonly cells
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
  private readonly paintNode: ComputeNode
  private readonly fillNode: ComputeNode

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    const cellCount = width * height
    const blockCount = (Math.floor(width / 2) + 1) * (Math.floor(height / 2) + 1)
    const size = uvec2(width, height)

    this.cells = instancedArray(cellCount, 'uint')

    const step = (offset: number) =>
      stepBlock({
        cells: this.cells,
        index: instanceIndex,
        size,
        offset: uint(offset),
        seed: this.seed,
      }).compute(blockCount, [64])

    this.stepEven = step(0)
    this.stepOdd = step(1)

    const pairCount = (Math.floor(width / 2) + 1) * Math.ceil(height / 2)
    this.flowRows = [0, 1].map((rowParity) =>
      flowPair({
        cells: this.cells,
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
      index: instanceIndex,
      size,
      mode: this.mode,
    }).compute(cellCount, [64])

    this.material = new MeshBasicNodeMaterial()
    // wgslFn calls are untyped in TSL's typings; sandColor returns vec4f.
    this.material.colorNode = sandColor({ cells: this.cells, uv: uv(), size, time }) as Node<'vec4'>
  }

  /**
   * One simulation step: two Margolus passes with alternating block offsets
   * (falling and sliding), then `maxSpread` sideways liquid-flow passes.
   */
  step(renderer: WebGPURenderer) {
    this.seed.value = randomSeed()
    renderer.compute(this.stepEven)
    this.seed.value = randomSeed()
    renderer.compute(this.stepOdd)

    for (let pass = 0; pass < maxSpread; pass++) {
      this.flowPass.value = pass
      this.flowOffset.value = (pass + this.stepCount) & 1
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
    this.seed.value = randomSeed()
    renderer.compute(this.paintNode)
  }

  /** Replace the whole grid with the starting level, or clear it. */
  fill(renderer: WebGPURenderer, what: 'level' | 'empty') {
    this.mode.value = what === 'level' ? 1 : 0
    renderer.compute(this.fillNode)
  }

  dispose() {
    this.material.dispose()
  }
}
