import { use, useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { BufferGeometry, Vector2, Vector3, type Line, type LineBasicMaterial, type LineSegments, type WebGPURenderer } from 'three/webgpu'
import { SandSim } from '../sim/SandSim'
import {
  BODY_FLOATS,
  BodyWorld,
  ballBody,
  beamBody,
  bodyOutline,
  boxBody,
  levelBodies,
  packBody,
  rapierReady,
  type Assembly,
  type BodySpec,
} from '../sim/bodies'
import { laserObject, laserTip } from '../sim/objects'
import { vehicleAssembly } from '../sim/vehicle'
import { decodeInspection } from '../sim/inspect'
import { materialByKey } from '../sim/materials'
import { heldKeys, input } from './input'
import { useSandbox } from './store'
import { isObjectTool, isPlacingTool, type Tool } from './tools'

const STEPS_PER_SECOND = 120
const MAX_STEPS_PER_FRAME = 4
/** The inspect tool reads the cell under the cursor back from the GPU every this many frames. */
const INSPECT_EVERY = 6

type Props = { width: number; height: number }

/**
 * What a drag from `a` to `b` places: a box corner to corner, a ball from its centre, a
 * beam end to end (as thick as the brush), a mining laser at `a` aimed at `b`, a vehicle
 * where the drag ends. Wooden boxes, rubber balls and steel beams; Shift makes boxes and
 * balls static, beams wooden and loose, and vehicles face left.
 */
function placementFor(tool: Tool, a: Vector2, b: Vector2, brushSize: number, shift: boolean): Assembly | null {
  const one = (spec: BodySpec): Assembly => ({ parts: [spec], joints: [] })
  if (tool === 'BOX') return one(boxBody(a.x, a.y, b.x, b.y, 'wood', shift))
  if (tool === 'BALL') return one(ballBody(a.x, a.y, a.distanceTo(b), 'rubber', shift))
  if (tool === 'BEAM') return one(beamBody(a.x, a.y, b.x, b.y, Math.max(brushSize, 4), shift ? 'wood' : 'steel', !shift))
  if (tool === 'LASER') return one(laserObject(a.x, a.y, b.x, b.y))
  if (tool === 'VEHICLE') return vehicleAssembly(b.x, b.y, shift ? -1 : 1)
  return null
}

/** Preview colours: a body, or an object that fits, doesn't (yet) or hasn't been checked. */
const PREVIEW_BODY = '#ffffff'
const PREVIEW_FITS = '#7dff8a'
const PREVIEW_BLOCKED = '#ff5a4f'
const PREVIEW_UNKNOWN = '#9aa0a6'

const probe = new Float32Array(BODY_FLOATS)

/** Show `points` on a line, in a new geometry when there are more or fewer than it holds (its buffers have a fixed size). */
function setLinePoints(line: Line, points: Vector3[]) {
  if (line.geometry.getAttribute('position')?.count !== points.length) {
    line.geometry.dispose()
    line.geometry = new BufferGeometry()
  }
  line.geometry.setFromPoints(points)
}

const isShiftHeld = () => heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight')

/** The sand grid as a plane spanning (0, 0) to (width, height) in world units; one unit per cell. */
export function SandWorld({ width, height }: Props) {
  use(rapierReady)
  const renderer = useThree((s) => s.gl) as unknown as WebGPURenderer
  const sim = useMemo(() => new SandSim(width, height), [width, height])
  useEffect(() => () => sim.dispose(), [sim])
  // Outlines of the bodies being dragged out, and where a laser will aim.
  const preview = useRef<LineSegments>(null)
  const aim = useRef<Line>(null)

  const state = useRef({
    accumulator: 0,
    resetCount: -1, // -1 forces the level to be generated on the first frame
    clearCount: 0,
    painting: false,
    last: new Vector2(),
    current: new Vector2(),
    /** Where the body being dragged out started. */
    dragStart: new Vector2(),
    /** Cell under the cursor (for the inspect tool), and whether a readback is in flight. */
    hover: null as Vector2 | null,
    inspecting: false,
    readingForces: false,
    readingGround: false,
    /** Whether the object being dragged out fits (null: not checked yet), and whether a check is in flight. */
    fits: null as boolean | null,
    checkingFit: false,
    frame: 0,
  })

  // Made in an effect, so the Rapier world freed on unmount is never reused.
  const bodiesRef = useRef<BodyWorld>(null)
  useEffect(() => {
    const bodies = new BodyWorld(width, height, sim.wordsPerColumn, STEPS_PER_SECOND)
    bodiesRef.current = bodies
    state.current.resetCount = -1 // regenerate the level, with its bodies
    return () => {
      bodiesRef.current = null
      bodies.dispose()
    }
  }, [width, height, sim])

  // World point (y up) -> grid cell coordinates (y down).
  const toGrid = (e: ThreeEvent<PointerEvent>, out: Vector2) => out.set(e.point.x, height - e.point.y)

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0 || useSandbox.getState().tool === 'INSPECT') return
    const s = state.current
    s.painting = true
    toGrid(e, s.current)
    s.last.copy(s.current)
    s.dragStart.copy(s.current)
  }
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const s = state.current
    if (s.painting) toGrid(e, s.current)
    s.hover = toGrid(e, s.hover ?? new Vector2())
  }
  const onPointerOut = () => {
    state.current.hover = null
  }

  // Whether an object fits where it would go: nothing but air, gases or liquids under any
  // of its parts. (The checks run in order on the GPU, each before the next upload.)
  const fitsOne = async (spec: BodySpec) => (await sim.checkPlacement(renderer, (packBody(spec, probe, 0), probe))) === 0
  const fits = async ({ parts }: Assembly) => (await Promise.all(parts.map(fitsOne))).every(Boolean)

  useEffect(() => {
    const stop = () => {
      const s = state.current
      if (!s.painting) return
      s.painting = false
      s.fits = null
      const game = useSandbox.getState()
      const placed = placementFor(game.tool, s.dragStart, s.current, game.brushSize, isShiftHeld())
      if (!placed) return
      if (!isObjectTool(game.tool)) bodiesRef.current?.addAssembly(placed)
      // Checked again as placed: the grid may have moved since the preview's check.
      else fits(placed).then((ok) => ok && bodiesRef.current?.addAssembly(placed))
    }
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  })

  useFrame((_, delta) => {
    const s = state.current
    const game = useSandbox.getState()
    const bodies = bodiesRef.current
    if (!bodies) return

    if (s.resetCount !== game.resetCount) {
      s.resetCount = game.resetCount
      sim.fill(renderer, 'level')
      bodies.clear()
      for (const spec of levelBodies()) bodies.add(spec)
    }
    if (s.clearCount !== game.clearCount) {
      s.clearCount = game.clearCount
      sim.fill(renderer, 'empty')
      bodies.clear()
    }

    const dragging = s.painting && isPlacingTool(game.tool)
    if (s.painting && !isPlacingTool(game.tool)) {
      if (game.tool === 'AIR') sim.blow(renderer, s.last, s.current, game.brushSize)
      else if (game.tool === 'VACUUM') sim.vacuum(renderer, s.last, s.current, game.brushSize)
      else if (game.tool !== 'INSPECT') {
        sim.paint(renderer, s.last, s.current, game.brushSize, materialByKey[game.tool].id)
        if (game.tool === 'EMPTY') bodies.removeNear(s.current.x, s.current.y, game.brushSize)
      }
      s.last.copy(s.current)
    }
    const placing = dragging ? placementFor(game.tool, s.dragStart, s.current, game.brushSize, isShiftHeld()) : null
    const placingObject = placing !== null && isObjectTool(game.tool)
    if (placingObject && !s.checkingFit) {
      s.checkingFit = true
      fits(placing)
        .then((ok) => (s.fits = s.painting ? ok : null))
        .finally(() => (s.checkingFit = false))
    }
    const toWorld = ([x, y]: [number, number]) => new Vector3(x, height - y, 1)
    const line = preview.current
    if (line) {
      line.visible = placing !== null
      if (placing) {
        // Each outline as segments, so the parts aren't joined up.
        const points = placing.parts.flatMap((spec) => {
          const outline = bodyOutline(spec).map(toWorld)
          return outline.flatMap((p, i) => [p, outline[(i + 1) % outline.length]])
        })
        setLinePoints(line, points)
        const color = !placingObject ? PREVIEW_BODY : s.fits === null ? PREVIEW_UNKNOWN : s.fits ? PREVIEW_FITS : PREVIEW_BLOCKED
        ;(line.material as LineBasicMaterial).color.set(color)
      }
    }
    const aiming = placing !== null && game.tool === 'LASER'
    if (aim.current) {
      aim.current.visible = aiming
      if (aiming) setLinePoints(aim.current, [toWorld(laserTip(placing.parts[0])), toWorld([s.current.x, s.current.y])])
    }
    sim.setPressureView(game.pressureView)

    // Inspect tool: read the cell under the cursor back now and then (one at a time).
    s.frame++
    if (game.tool === 'INSPECT' && s.hover && !s.inspecting && s.frame % INSPECT_EVERY === 0) {
      s.inspecting = true
      sim
        .inspect(renderer, s.hover)
        .then((raw) => useSandbox.getState().inspect(decodeInspection(raw)))
        .finally(() => (s.inspecting = false))
    }

    // Bodies move, carry what rests on them along, and are stamped into the grid; lasers
    // fire, then the grid steps around them. Paused, lasers only trace their beams.
    const stamp = (mine: boolean) => {
      const packed = bodies.pack()
      if (packed) sim.stampBodies(packed.data, packed.pressures, packed.from, packed.to)
      const shelters = bodies.packShelters()
      sim.setShelters(shelters.data, shelters.count)
      const lasers = bodies.packLasers()
      sim.fireLasers(lasers.data, lasers.count, mine)
      return lasers.count > 0
    }
    if (game.paused) {
      stamp(false)
      sim.flush(renderer)
    } else {
      s.accumulator = Math.min(s.accumulator + delta * STEPS_PER_SECOND, MAX_STEPS_PER_FRAME)
      let mined = false
      bodies.control(Number(input.driveRight()) - Number(input.driveLeft()), input.tip())
      while (s.accumulator >= 1) {
        bodies.step()
        const carried = bodies.carries()
        sim.carry(carried.data, carried.count, carried.from, carried.to)
        mined = stamp(true) || mined
        sim.step(renderer)
        s.accumulator -= 1
      }
      // Mining can leave stone too thin to stand.
      if (mined) sim.crumble(renderer)
    }

    // Read back the forces on the bodies and the ground they stand on, one readback of
    // each at a time; they apply a frame or two late.
    const anyBodies = bodies.count > 0
    sim.measureBodies(renderer, anyBodies)
    if (!s.readingForces && anyBodies) {
      s.readingForces = true
      const measured = bodies.snapshot()
      sim
        .readBodyForces(renderer)
        .then((raw) => bodies.applyForces(raw, measured))
        .finally(() => (s.readingForces = false))
    }
    if (!s.readingGround) {
      s.readingGround = true
      sim
        .readSolidMask(renderer)
        .then((bits) => bodies.applyGround(bits))
        .finally(() => (s.readingGround = false))
    }
  })

  return (
    <>
      <mesh
        position={[width / 2, height / 2, 0]}
        material={sim.material}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerOut={onPointerOut}
      >
        <planeGeometry args={[width, height]} />
      </mesh>
      <lineSegments ref={preview} visible={false}>
        <lineBasicMaterial color={PREVIEW_BODY} />
      </lineSegments>
      <threeLine ref={aim} visible={false}>
        <lineBasicMaterial color="#ff8a7a" transparent opacity={0.6} />
      </threeLine>
    </>
  )
}
