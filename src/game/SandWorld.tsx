import { use, useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { BufferGeometry, Vector2, Vector3, type Line, type LineBasicMaterial, type LineSegments, type OrthographicCamera, type WebGPURenderer } from 'three/webgpu'
import { SandSim } from '../sim/SandSim'
import { BODY_FLOATS, BodyWorld, ballBody, beamBody, bodyOutline, boxBody, packBody, rapierReady, type Assembly, type BodySpec } from '../sim/bodies'
import { ChunkManager, ChunkState } from '../world/ChunkManager'
import { biomeAt, surfaceHeight } from '../world/biomes'
import { WORLD_SEED, WORLD_SIZE } from '../world/config'
import { Overview } from '../world/overview'
import { decodeSave, encodeSave, readQuickSave, writeQuickSave } from '../world/save'
import { laserObject, laserTip } from '../sim/objects'
import { vehicleAssembly } from '../sim/vehicle'
import { decodeInspection } from '../sim/inspect'
import { materialByKey } from '../sim/materials'
import { heldKeys, input } from './input'
import { useSandbox } from './store'
import { isObjectTool, isPlacingTool, type Tool } from './tools'

const STEPS_PER_SECOND = 120
const MAX_STEPS_PER_FRAME = 4
/** Steps a frame while a new world settles (ChunkManager SETTLE_STEPS), behind the loading screen. */
const SETTLE_STEPS_PER_FRAME = 8
/** The inspect tool reads the cell under the cursor back from the GPU every this many frames. */
const INSPECT_EVERY = 6
/** The world map in the HUD is refreshed every this many frames. */
const MAP_EVERY = 15

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

/**
 * The world, WORLD_SIZE cells square, one world unit per cell (y up; cells count y down
 * from the top). SandSim draws the chunks on the GPU onto a plane over all of it; the
 * overview behind shows through where they aren't. ChunkManager decides which chunks are
 * where.
 */
export function SandWorld() {
  use(rapierReady)
  const renderer = useThree((s) => s.gl) as unknown as WebGPURenderer
  const camera = useThree((s) => s.camera) as OrthographicCamera
  const size = useThree((s) => s.size)
  const sim = useMemo(() => new SandSim(), [])
  const overview = useMemo(() => new Overview(), [])
  useEffect(() => () => sim.dispose(), [sim])
  useEffect(() => () => overview.dispose(), [overview])
  // Outlines of the bodies being dragged out, and where a laser will aim.
  const preview = useRef<LineSegments>(null)
  const aim = useRef<Line>(null)

  const state = useRef({
    accumulator: 0,
    resetCount: -1, // -1 forces the world to be generated on the first frame
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
    /** Whether the object being dragged out fits (null: not checked yet), and whether a check is in flight. */
    fits: null as boolean | null,
    checkingFit: false,
    frame: 0,
  })

  // Made in an effect, so the Rapier world freed on unmount is never reused.
  const bodiesRef = useRef<BodyWorld>(null)
  const worldRef = useRef<ChunkManager>(null)
  useEffect(() => {
    const bodies = new BodyWorld(WORLD_SIZE, WORLD_SIZE, STEPS_PER_SECOND)
    const world = new ChunkManager(sim, renderer, bodies, overview, WORLD_SEED, STEPS_PER_SECOND)
    bodiesRef.current = bodies
    worldRef.current = world
    state.current.resetCount = -1 // generate the world, with its bodies
    const game = useSandbox.getState()
    const report = (what: string, run: () => Promise<void>) =>
      run().then(
        () => game.notify(what),
        (error: Error) => game.notify(`${error.message}`),
      )
    const save = () => world.save({ x: camera.position.x, y: WORLD_SIZE - camera.position.y, zoom: camera.zoom }).then(encodeSave)
    const load = async (file: Blob) => {
      const saved = await decodeSave(file)
      world.load(saved)
      camera.position.set(saved.header.camera.x, WORLD_SIZE - saved.header.camera.y, camera.position.z)
      camera.zoom = saved.header.camera.zoom
      camera.updateProjectionMatrix()
    }
    useSandbox.setState({
      persistence: {
        quickSave: () => report('Saved.', async () => void (await writeQuickSave(await save()))),
        quickLoad: () =>
          report('Loaded.', async () => {
            const file = await readQuickSave()
            if (!file) throw new Error('Nothing saved yet.')
            await load(file)
          }),
        exportFile: () =>
          report('Saved to a file.', async () => {
            const link = document.createElement('a')
            link.href = URL.createObjectURL(await save())
            link.download = `sandbox-${world.seed}.sandsave`
            link.click()
            setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
          }),
        importFile: (file: File) => report('Loaded.', () => load(file)),
      },
    })
    // For poking at the world from the console (and tests) in development.
    if (import.meta.env.DEV) Object.assign(window, { sandbox: { world, sim, bodies, camera, renderer, save, load } })
    return () => {
      useSandbox.setState({ persistence: null })
      bodiesRef.current = null
      worldRef.current = null
      world.dispose()
      bodies.dispose()
    }
  }, [sim, renderer, overview, camera])

  // World point (y up) -> world cell coordinates (y down).
  const toGrid = (e: ThreeEvent<PointerEvent>, out: Vector2) => out.set(e.point.x, WORLD_SIZE - e.point.y)

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
    const world = worldRef.current
    if (!bodies || !world) return
    // Where the camera looks, and what it sees, in world cells.
    const camX = camera.position.x
    const camY = WORLD_SIZE - camera.position.y
    const halfWidth = size.width / 2 / camera.zoom
    const halfHeight = size.height / 2 / camera.zoom

    if (s.resetCount !== game.resetCount) {
      s.resetCount = game.resetCount
      world.reset('terrain')
    }
    if (s.clearCount !== game.clearCount) {
      s.clearCount = game.clearCount
      world.reset('empty')
    }
    world.update({ x: camX, y: camY, x0: camX - halfWidth, y0: camY - halfHeight, x1: camX + halfWidth, y1: camY + halfHeight })
    const loading = world.loading
    if (loading?.phase !== game.loading?.phase || loading?.done !== game.loading?.done || loading?.total !== game.loading?.total) game.showLoading(loading)

    const dragging = s.painting && isPlacingTool(game.tool)
    if (s.painting && !isPlacingTool(game.tool)) {
      if (game.tool !== 'INSPECT') {
        // Painting wakes the chunks it touches first, so they take the change and carry on from it.
        const r = game.brushSize + 1
        world.wakeRect(Math.min(s.last.x, s.current.x) - r, Math.min(s.last.y, s.current.y) - r, Math.max(s.last.x, s.current.x) + r, Math.max(s.last.y, s.current.y) + r)
      }
      const [from, to] = [s.last, s.current]
      if (game.tool === 'AIR') sim.blow(renderer, from, to, game.brushSize)
      else if (game.tool === 'VACUUM') sim.vacuum(renderer, from, to, game.brushSize)
      else if (game.tool !== 'INSPECT') {
        sim.paint(renderer, from, to, game.brushSize, materialByKey[game.tool].id)
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
    const toWorld = ([x, y]: [number, number]) => new Vector3(x, WORLD_SIZE - y, 1)
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
    if (s.frame % MAP_EVERY === 0) {
      const [cx, cy] = world.cameraChunkIndex ?? [0, 0]
      const states = world.states()
      game.showWorld({
        seed: world.seed,
        states,
        camera: [cx, cy],
        view: [camX - halfWidth, camY - halfHeight, camX + halfWidth, camY + halfHeight],
        biome: world.mode === 'empty' ? 'None' : biomeAt(world.seed, camX, camY, surfaceHeight(world.seed, camX)).name,
        live: states.filter((v) => v === ChunkState.Live).length,
        loaded: states.filter((v) => v >= ChunkState.Frozen).length,
        stored: states.filter((v) => v === ChunkState.Stored).length,
        dormant: world.dormantCount,
      })
    }
    overview.flush(performance.now())

    // Bodies move, carry what rests on them along, and are stamped into the grid; lasers
    // fire, then the grid steps around them. Paused, lasers only trace their beams.
    // Bodies that move, and lasers that mine, wake the chunks they're in (or reach).
    const stamp = (mine: boolean) => {
      const packed = bodies.pack()
      for (const [x0, y0, x1, y1] of bodies.takeMoved()) world.wakeRect(x0, y0, x1, y1)
      if (packed) sim.stampBodies(packed.data, packed.pressures, packed.from, packed.to)
      const shelters = bodies.packShelters()
      sim.setShelters(shelters.data, shelters.count)
      const lasers = bodies.packLasers()
      if (mine) for (const [x0, y0, x1, y1] of lasers.beams) world.wakeSegment(x0, y0, x1, y1)
      sim.fireLasers(lasers.data, lasers.count, mine)
      return lasers.count > 0
    }
    if (loading?.phase === 'settling') {
      // A new world settles behind the loading screen, a few steps a frame (bodies wait).
      for (let k = 0; k < SETTLE_STEPS_PER_FRAME && world.loading; k++) {
        sim.step(renderer)
        world.afterStep()
        world.settled()
      }
    } else if (game.paused || loading) {
      stamp(false)
      sim.flush(renderer)
    } else {
      s.accumulator = Math.min(s.accumulator + delta * STEPS_PER_SECOND, MAX_STEPS_PER_FRAME)
      let mined = false
      bodies.control(Number(input.driveRight()) - Number(input.driveLeft()), input.tip())
      while (s.accumulator >= 1) {
        bodies.step()
        const carried = bodies.carries()
        sim.carry(carried.data, carried.count, carried.from, carried.to, carried.top, carried.bottom)
        mined = stamp(true) || mined
        sim.step(renderer)
        world.afterStep()
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
    world.readGround()
  })

  return (
    <>
      <mesh position={[WORLD_SIZE / 2, WORLD_SIZE / 2, -1]} material={overview.material}>
        <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
      </mesh>
      <mesh
        position={[WORLD_SIZE / 2, WORLD_SIZE / 2, 0]}
        material={sim.material}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerOut={onPointerOut}
      >
        <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
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
