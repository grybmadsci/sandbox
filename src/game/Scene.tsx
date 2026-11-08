import { Grid } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { CameraRig } from './CameraRig'
import { World } from './World'
import { Bodies } from './Bodies'
import { useSandbox } from './store'

export function Scene() {
  const spawn = useSandbox((s) => s.spawn)

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    spawn([e.point.x, e.point.y])
  }

  return (
    <>
      <color attach="background" args={['#0f1420']} />
      <ambientLight intensity={1.2} />
      <directionalLight position={[5, 10, 20]} intensity={1.5} />

      <CameraRig />

      {/* Background grid in the XY plane, behind everything. */}
      <Grid
        position-z={-5}
        rotation-x={Math.PI / 2}
        cellColor="#1b2233"
        sectionColor="#27314a"
        infiniteGrid
        fadeDistance={1000}
      />

      {/* Invisible click target covering the play plane, used for spawning. */}
      <mesh position-z={-1} onPointerDown={onPointerDown}>
        <planeGeometry args={[100000, 100000]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      <World />
      <Bodies />
    </>
  )
}
