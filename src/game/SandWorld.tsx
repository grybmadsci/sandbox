import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Vector2, type WebGPURenderer } from 'three/webgpu'
import { SandSim } from '../sim/SandSim'
import { decodeInspection } from '../sim/inspect'
import { materialByKey } from '../sim/materials'
import { useSandbox } from './store'

const STEPS_PER_SECOND = 120
const MAX_STEPS_PER_FRAME = 4
/** The inspect tool reads the cell under the cursor back from the GPU every this many frames. */
const INSPECT_EVERY = 6

type Props = { width: number; height: number }

/** The sand grid as a plane spanning (0, 0) to (width, height) in world units; one unit per cell. */
export function SandWorld({ width, height }: Props) {
  const renderer = useThree((s) => s.gl) as unknown as WebGPURenderer
  const sim = useMemo(() => new SandSim(width, height), [width, height])
  useEffect(() => () => sim.dispose(), [sim])

  const state = useRef({
    accumulator: 0,
    resetCount: -1, // -1 forces the level to be generated on the first frame
    clearCount: 0,
    painting: false,
    last: new Vector2(),
    current: new Vector2(),
    /** Cell under the cursor (for the inspect tool), and whether a readback is in flight. */
    hover: null as Vector2 | null,
    inspecting: false,
    frame: 0,
  })

  // World point (y up) -> grid cell coordinates (y down).
  const toGrid = (e: ThreeEvent<PointerEvent>, out: Vector2) => out.set(e.point.x, height - e.point.y)

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0 || useSandbox.getState().tool === 'INSPECT') return
    const s = state.current
    s.painting = true
    toGrid(e, s.current)
    s.last.copy(s.current)
  }
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const s = state.current
    if (s.painting) toGrid(e, s.current)
    s.hover = toGrid(e, s.hover ?? new Vector2())
  }
  const onPointerOut = () => {
    state.current.hover = null
  }

  useEffect(() => {
    const stop = () => (state.current.painting = false)
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  }, [])

  useFrame((_, delta) => {
    const s = state.current
    const game = useSandbox.getState()

    if (s.resetCount !== game.resetCount) {
      s.resetCount = game.resetCount
      sim.fill(renderer, 'level')
    }
    if (s.clearCount !== game.clearCount) {
      s.clearCount = game.clearCount
      sim.fill(renderer, 'empty')
    }

    if (s.painting) {
      if (game.tool === 'AIR') sim.blow(renderer, s.last, s.current, game.brushSize)
      else if (game.tool === 'VACUUM') sim.vacuum(renderer, s.last, s.current, game.brushSize)
      else if (game.tool !== 'INSPECT') sim.paint(renderer, s.last, s.current, game.brushSize, materialByKey[game.tool].id)
      s.last.copy(s.current)
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

    if (game.paused) return
    s.accumulator = Math.min(s.accumulator + delta * STEPS_PER_SECOND, MAX_STEPS_PER_FRAME)
    while (s.accumulator >= 1) {
      sim.step(renderer)
      s.accumulator -= 1
    }
  })

  return (
    <mesh
      position={[width / 2, height / 2, 0]}
      material={sim.material}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerOut={onPointerOut}
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  )
}
