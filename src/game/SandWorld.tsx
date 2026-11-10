import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Vector2, type WebGPURenderer } from 'three/webgpu'
import { SandSim } from '../sim/SandSim'
import { materialByKey } from '../sim/materials'
import { useSandbox } from './store'

const STEPS_PER_SECOND = 120
const MAX_STEPS_PER_FRAME = 4

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
  })

  // World point (y up) -> grid cell coordinates (y down).
  const toGrid = (e: ThreeEvent<PointerEvent>, out: Vector2) => out.set(e.point.x, height - e.point.y)

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    const s = state.current
    s.painting = true
    toGrid(e, s.current)
    s.last.copy(s.current)
  }
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (state.current.painting) toGrid(e, state.current.current)
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
      else sim.paint(renderer, s.last, s.current, game.brushSize, materialByKey[game.tool].id)
      s.last.copy(s.current)
    }
    sim.setPressureView(game.pressureView)

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
    >
      <planeGeometry args={[width, height]} />
    </mesh>
  )
}
